import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { JobCache } from "../src/core/jobCache.js";
import { WorkProtocol } from "../src/core/router.js";
import { WORK_MCP_TOOLS, createWorkMcpServer, renderConnectors } from "../src/mcp/server.js";
import { builtInVerifiers } from "../src/verifiers/index.js";
import { fullStageConnector, searchOnlyConnector, throwingConnector } from "./helpers/fakeConnectors.js";
import { wav } from "./helpers/media.js";

type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> };

describe("MCP server", () => {
  const protocol = new WorkProtocol({
    connectors: [fullStageConnector(), searchOnlyConnector(), throwingConnector()],
    env: {},
    cache: new JobCache(),
    searchTimeoutMs: 500,
    allowLocalFiles: false,
    verifiers: builtInVerifiers,
  });
  const client = new Client({ name: "test", version: "0" });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
  const text = (r: Result) => r.content?.find((c) => c.type === "text")?.text ?? "";

  beforeAll(async () => {
    const server = createWorkMcpServer(protocol, { allowLocalFiles: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  it("lists every tool with output schemas and complete annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...WORK_MCP_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} has no output schema`).toBeDefined();
      expect(tool.description?.length).toBeGreaterThan(20);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
    expect(tools.find((t) => t.name === "remove_work")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "apply_to_job")?.annotations?.idempotentHint).toBe(true);
  });

  it("serves the guide and the prompt", async () => {
    const guide = await client.readResource({ uri: "work://guide" });
    expect((guide.contents[0] as { text?: string } | undefined)?.text).toContain("search_jobs");
    const prompt = await client.getPrompt({ name: "find-work", arguments: { role: "electrician", location: "Accra" } });
    expect(prompt.messages[0]?.content).toMatchObject({ type: "text", text: expect.stringContaining("electrician") });
  });

  it("lists connectors", async () => {
    const result = await call("list_connectors");
    expect(result.isError).toBeFalsy();
    const connectors = result.structuredContent?.connectors as Array<{ id: string; stages: string[]; auth: { configured: boolean } }>;
    expect(connectors.map((c) => c.id)).toEqual(["fake-tasks", "fake-board", "fake-broken"]);
    expect(connectors[0]?.stages).toContain("apply");
    expect(text(result)).toContain("fake-tasks");
  });

  it("searches: tasks only without a query, boards with one, failures in partial", async () => {
    const tasks = await call("search_jobs", {});
    expect(tasks.isError).toBeFalsy();
    expect((tasks.structuredContent?.jobs as Array<{ id: string }>).map((j) => j.id)).toEqual(["fake-tasks:t2", "fake-tasks:t1"]); // better paid first
    expect(tasks.structuredContent?.partial).toEqual([]);
    const jobs = await call("search_jobs", { query: "electrician" });
    const ids = (jobs.structuredContent?.jobs as Array<{ id: string; description?: string }>).map((j) => j.id);
    expect(ids).toContain("fake-board:l1");
    expect((jobs.structuredContent?.jobs as Array<{ description?: string }>).every((j) => j.description === undefined)).toBe(true);
    expect(jobs.structuredContent?.partial).toEqual([{ connector: "fake-broken", error: { code: "upstream_error", message: "boom" } }]);
    expect(text(jobs)).toContain("fake-broken failed");
    const invalid = await call("search_jobs", { limit: 500 });
    expect(invalid.isError).toBe(true);
  });

  it("gets a listing from the cache and refuses to apply to it", async () => {
    const job = await call("get_job", { job_id: "fake-board:l1" });
    expect(job.structuredContent).toMatchObject({
      id: "fake-board:l1",
      title: "Electrician",
      apply_hint: expect.stringContaining("Apply at"),
    });
    const apply = await call("apply_to_job", { job_id: "fake-board:l1" });
    expect(apply.isError).toBe(true);
    expect(apply.structuredContent).toMatchObject({
      error: "not_supported",
      details: { stage: "apply", apply_hint: expect.stringContaining("board.example") },
    });
    expect(text(apply)).toContain("Apply at https://board.example");
    const missing = await call("get_job", { job_id: "fake-board:l999" });
    expect(missing.structuredContent).toMatchObject({ error: "not_found" });
  });

  it("runs a task end to end", async () => {
    const task = await call("get_job", { job_id: "fake-tasks:t2" });
    expect(task.structuredContent).toMatchObject({ kind: "task", requirements: { text: { min_chars: 20 } } });
    expect(text(task)).toContain("Written answer");

    const applied = await call("apply_to_job", { job_id: "fake-tasks:t2" });
    expect(applied.isError).toBeFalsy();
    expect(applied.structuredContent).toMatchObject({ id: "fake-tasks:a1", stage: "work_needed", progress: { received: 0, wanted: 1 } });

    const local = await call("add_work", { application_id: "fake-tasks:a1", file: { path: "C:/secret.txt" } });
    expect(local.isError).toBe(true);
    expect(local.structuredContent).toMatchObject({ error: "invalid_input" });

    const added = await call("add_work", { application_id: "fake-tasks:a1", text: "Positive: the customer says they will return." });
    expect(added.structuredContent).toMatchObject({
      application_id: "fake-tasks:a1",
      file: { kind: "text" },
      progress: { received: 1, wanted: 1, ready_to_submit: true },
    });
    expect(text(added)).toContain("ready to submit");

    const submitted = await call("submit_work", { application_id: "fake-tasks:a1", note: "done" });
    expect(submitted.structuredContent).toMatchObject({ stage: "in_review" });
    const status = await call("get_application", { application_id: "fake-tasks:a1" });
    expect(status.structuredContent).toMatchObject({ stage: "in_review", job_title: "Label short texts" });

    const audio = await call("apply_to_job", { job_id: "fake-tasks:t1", answers: { q1: "English" } });
    expect(audio.structuredContent).toMatchObject({ id: "fake-tasks:a2", stage: "work_needed" });
    const clip = await call("add_work", {
      application_id: "fake-tasks:a2",
      file: { base64: Buffer.from("ID3 fake audio bytes").toString("base64"), name: "clip.mp3" },
    });
    expect(clip.structuredContent).toMatchObject({ file: { kind: "audio", name: "clip.mp3" } });
    const removed = await call("remove_work", { application_id: "fake-tasks:a2", file_id: "f1" });
    expect(removed.structuredContent).toMatchObject({ removed: { id: "f1" }, progress: { received: 0 } });

    const mine = await call("my_applications", {});
    expect(mine.structuredContent).toMatchObject({ count: 2 });
    const link = await call("get_work_link", { application_id: "fake-tasks:a2" });
    expect(link.structuredContent).toMatchObject({ application_id: "fake-tasks:a2", url: "https://fake.example/finish/a2" });
  });

  it("reports accounts and updates profiles", async () => {
    const me = await call("whoami");
    expect(me.structuredContent).toMatchObject({ accounts: [{ connector: "fake-tasks", signed_in: true, ready: true }] });
    expect(text(me)).toContain("ready to apply");
    const updated = await call("update_profile", { connector: "fake-tasks", fields: { location: "Accra" } });
    expect(updated.structuredContent).toMatchObject({ connector: "fake-tasks", profile: { location: "Accra" } });
    const bad = await call("update_profile", { connector: "fake-tasks", fields: { nope: 1 } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ error: "invalid_input", details: { allowed: ["location"] } });
  });

  it("verifies work before it is sent", async () => {
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
    const good = await call("verify_work", {
      job_id: "fake-tasks:t1",
      work: [{ file: { base64: b64(wav(10, 1)), name: "one.wav" } }, { file: { base64: b64(wav(12, 2)), name: "two.wav" } }],
      answers: { q1: "English" },
    });
    expect(good.isError).toBeFalsy();
    expect(good.structuredContent).toMatchObject({
      job_id: "fake-tasks:t1",
      outcome: "pass",
      deterministic: true,
      accepted_units: 2,
      pay: { amount: 1, currency: "USD" },
    });
    expect(text(good)).toContain("Pass");
    const bad = await call("verify_work", {
      job_id: "fake-tasks:t1",
      work: [{ file: { base64: b64(wav(45, 1)), name: "long.wav" } }],
      answers: { q1: "English" },
    });
    expect(bad.structuredContent).toMatchObject({ outcome: "fail" });
    expect(text(bad)).toContain("the limit is 30 s");
    const local = await call("verify_work", { job_id: "fake-tasks:t1", work: [{ file: { path: "C:/x.wav" } }] });
    expect(local.structuredContent).toMatchObject({ error: "invalid_input" });
  });

  it("reports earnings and requests a payout", async () => {
    const earnings = await call("my_earnings", {});
    expect(earnings.isError).toBeFalsy();
    expect(earnings.structuredContent).toMatchObject({
      earnings: [{ connector: "fake-tasks", balance: { amount: 30, currency: "USD" }, methods: ["paypal", "venmo"] }],
      partial: [],
    });
    expect(text(earnings)).toContain("balance USD 30");
    const refused = await call("request_payout", { connector: "fake-board", method: "paypal" });
    expect(refused.structuredContent).toMatchObject({ error: "not_supported" });
    const small = await call("request_payout", { connector: "fake-tasks", method: "paypal", amount: 5 });
    expect(small.structuredContent).toMatchObject({ error: "not_ready", details: { min_payout: { amount: 10 } } });
    const payout = await call("request_payout", { connector: "fake-tasks", method: "venmo", destination: "@ama", amount: 12 });
    expect(payout.isError).toBeFalsy();
    expect(payout.structuredContent).toMatchObject({
      id: "fake-tasks:p1",
      connector: "fake-tasks",
      amount: { amount: 12, currency: "USD" },
      method: "venmo",
      status: "requested",
    });
    expect(text(payout)).toContain("via venmo to @ama");
  });
});

describe("renderConnectors", () => {
  it("marks connectors that are searched only when named", () => {
    const base = {
      name: "X",
      description: "d",
      kinds: ["task" as const],
      stages: ["search" as const],
      auth: { type: "none" as const, configured: true, required: false },
    };
    const text = renderConnectors([
      { id: "a", ...base },
      { id: "b", ...base, opt_in: true },
    ]);
    const [a, , b] = text.split("\n");
    expect(a).not.toContain("searched only when named");
    expect(b).toContain("searched only when named");
  });
});
