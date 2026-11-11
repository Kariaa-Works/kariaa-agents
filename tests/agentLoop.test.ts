/**
 * The model-driven example's loop and guards, with a scripted model in place of
 * a real one and the Work API's real MCP server over an in-memory connection.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { WorkProtocol } from "../src/core/router.js";
import { createWorkMcpServer } from "../src/mcp/server.js";
import { builtInVerifiers } from "../src/verifiers/index.js";
import {
  MAX_WRITES,
  READ_TOOLS,
  runAgent,
  type ContentBlock,
  type ModelCall,
  type StopReason,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../workflows/openai-agent/agent.js";
import { fullStageConnector } from "./helpers/fakeConnectors.js";

async function workServer() {
  const protocol = new WorkProtocol({ connectors: [fullStageConnector()], verifiers: builtInVerifiers, env: {}, cache: null });
  const server = createWorkMcpServer(protocol, { allowLocalFiles: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

let nextId = 0;
const use = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id: `tu_${nextId++}`, name, input });
const say = (text: string) => ({ type: "text", text }) as const;

/** A model that plays back a script, one reply per turn, and records what it was shown. */
function scripted(turns: Array<{ content: ContentBlock[]; stop_reason: StopReason }>) {
  const seen: Parameters<ModelCall>[0][] = [];
  const model: ModelCall = async (request) => {
    seen.push({ ...request, messages: [...request.messages] });
    return turns[Math.min(seen.length - 1, turns.length - 1)]!;
  };
  return { model, seen };
}

const lastResults = (request: Parameters<ModelCall>[0]) =>
  (request.messages.at(-1)!.content as ToolResultBlock[]).map((r) => ({
    error: r.is_error === true,
    text: String(r.content),
  }));

describe("the model-driven example", () => {
  it("offers only read tools without --act, runs what the model asks for and returns its answer", async () => {
    const work = await workServer();
    const { model, seen } = scripted([
      { content: [say("Looking."), use("search_jobs", {})], stop_reason: "tool_use" },
      { content: [say("Found two tasks: fake-tasks:t1 and fake-tasks:t2.")], stop_reason: "end_turn" },
    ]);
    const result = await runAgent({ goal: "Find tasks", act: false, work, model });
    expect(result).toMatchObject({ ended: "answered", turns: 2, writes: 0, answer: "Found two tasks: fake-tasks:t1 and fake-tasks:t2." });
    expect(seen[0]!.tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    expect(seen[0]!.tools.some((t) => t.name === "apply_to_job" || t.name === "pay_for_work")).toBe(false);
    // The model saw the search result as the tool's structured content.
    expect(lastResults(seen[1]!)[0]!.text).toContain("fake-tasks:t1");
    await work.close();
  });

  it("refuses a write tool the run does not allow, even when the model asks for it", async () => {
    const work = await workServer();
    const { model, seen } = scripted([
      { content: [use("apply_to_job", { job_id: "fake-tasks:t1" }), use("pay_for_work", { posting_id: "x:1" })], stop_reason: "tool_use" },
      { content: [say("I could not apply.")], stop_reason: "end_turn" },
    ]);
    const result = await runAgent({ goal: "Apply", act: false, work, model });
    expect(result.calls).toEqual([
      { name: "apply_to_job", ran: false, reason: "apply_to_job is not available in this run." },
      { name: "pay_for_work", ran: false, reason: "pay_for_work is not available in this run." },
    ]);
    expect(lastResults(seen[1]!).every((r) => r.error)).toBe(true);
    await work.close();
  });

  it("never lets the model pay, with or without --act", async () => {
    const work = await workServer();
    const { model } = scripted([
      { content: [use("pay_for_work", { posting_id: "x:1", action: "release" })], stop_reason: "tool_use" },
      { content: [say("ok")], stop_reason: "end_turn" },
    ]);
    const result = await runAgent({ goal: "Pay", act: true, work, model });
    expect(result.calls[0]).toMatchObject({ name: "pay_for_work", ran: false });
    await work.close();
  });

  it("caps writes and will not send a local file the model was talked into naming", async () => {
    const work = await workServer();
    const apply = () => use("apply_to_job", { job_id: "fake-tasks:t1", answers: { q1: "English" } });
    const { model, seen } = scripted([
      {
        content: [use("add_work", { application_id: "fake-tasks:a1", file: { path: "C:/Users/someone/.ssh/id_rsa" } })],
        stop_reason: "tool_use",
      },
      { content: [apply(), apply(), apply(), apply()], stop_reason: "tool_use" },
      { content: [say("done")], stop_reason: "end_turn" },
    ]);
    const result = await runAgent({ goal: "Do it", act: true, work, model });
    expect(result.calls[0]).toEqual({
      name: "add_work",
      ran: false,
      reason: "Local file paths are not accepted in this run. Send text, or a public https url.",
    });
    expect(result.writes).toBe(MAX_WRITES);
    expect(result.calls.filter((c) => c.name === "apply_to_job").map((c) => c.ran)).toEqual([true, true, true, false]);
    expect(lastResults(seen[2]!).at(-1)).toEqual({ error: true, text: `This run may write at most ${MAX_WRITES} times.` });
    await work.close();
  });

  it("stops on a refusal, on a cut-off reply and at the turn limit", async () => {
    const work = await workServer();
    const refusal = scripted([{ content: [], stop_reason: "refusal" }]);
    expect((await runAgent({ goal: "x", act: false, work, model: refusal.model })).ended).toBe("refused");
    const cut = scripted([{ content: [say("half a sen")], stop_reason: "max_tokens" }]);
    expect((await runAgent({ goal: "x", act: false, work, model: cut.model })).ended).toBe("cut_off");
    const forever = scripted([{ content: [use("search_jobs", {})], stop_reason: "tool_use" }]);
    const looped = await runAgent({ goal: "x", act: false, work, model: forever.model });
    expect(looped).toMatchObject({ ended: "turn_limit", turns: 16 });
    await work.close();
  });
});
