import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { McpClientPool } from "../src/core/mcpClient.js";
import { testContext } from "../src/core/conformance.js";
import { stagesOf } from "../src/core/connector.js";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildArgs,
  camelId,
  defineMcpConnector,
  draftProfile,
  McpProfileSchema,
  renderProfileModule,
  writeDraft,
  type McpProfile,
} from "../src/core/mcp/index.js";
import { createFakeMcp } from "./helpers/fakeMcpServer.js";

const PROFILE: McpProfile = {
  id: "fake-market",
  name: "Fake Market",
  description: "A marketplace with every stage, for tests.",
  homepage: "https://fake.example",
  kinds: ["task"],
  transport: { type: "http", url: "https://fake.example/mcp" },
  auth: { type: "bearer", env: "FAKE_MARKET_KEY", help: "Keys at https://fake.example/keys", required: false },
  tools: {
    search: {
      name: "browse_jobs",
      args: { search: "$.query", status: "open", limit: { from: "$.limit", transform: "int", default: 10 } },
      items: "$.jobs",
      more: "$.pagination.has_more",
      map: {
        id: "$.id",
        title: "$.title",
        org: "$.poster.name",
        "pay.text": { template: "USD ${asking_price}" },
        "pay.min": "$.asking_price",
        "pay.currency": { const: "USD" },
        summary: "$.description",
        url: { template: "https://fake.example/jobs/${id}" },
        posted_at: "$.created_at",
        tags: "$.category",
        "location.remote": { const: true },
      },
      filter: ["location"],
    },
    get: {
      name: "get_job",
      args: { job_id: "$.id" },
      root: "$.job",
      map: { id: "$.id", title: "$.title", description: "$.description", url: { template: "https://fake.example/jobs/${id}" } },
    },
    apply: {
      name: "submit_bid",
      args: {
        job_id: "$.id",
        amount: { from: "$.answers.amount", required: true, transform: "int" },
        description: { from: "$.note", default: "Ready to start." },
      },
      map: {
        id: "$.bid.job_id",
        stage: { const: "applied" },
        next: { const: "Wait for the buyer to accept the bid." },
        url: { template: "https://fake.example/jobs/${bid.job_id}" },
      },
    },
    submit: { name: "request_close", args: { job_id: "$.id" }, map: { stage: { const: "in_review" } }, then: "status" },
    status: {
      name: "get_my_jobs",
      args: { role: "bidder" },
      items: "$.rows",
      map: {
        id: "$.job_id",
        job_id: "$.job_id",
        job_title: "$.title",
        stage: {
          path: "$.status",
          values: { open: "applied", in_progress: "work_needed", close_requested: "in_review", completed: "accepted", cancelled: "closed" },
        },
      },
    },
    list: {
      name: "get_my_jobs",
      args: { role: "bidder" },
      items: "$.rows",
      map: {
        id: "$.job_id",
        job_id: "$.job_id",
        job_title: "$.title",
        stage: { path: "$.status", values: { open: "applied", in_progress: "work_needed", completed: "accepted", "*": "closed" } },
      },
    },
    earnings: {
      name: "get_my_payments",
      args: {},
      map: {
        "balance.amount": "$.available_cents",
        "balance.currency": { const: "USD" },
        entries: {
          items: "$.transfers",
          fields: {
            id: "$.id",
            amount: "$.amount_cents",
            currency: { const: "USD" },
            status: { path: "$.state", values: { paid: "paid", pending: "pending" } },
            job_title: "$.job_title",
          },
        },
        methods: { const: ["stripe"] },
      },
    },
    account: { name: "get_me", args: {}, map: { label: "$.username", ready: "$.can_bid", missing: { path: "$.blockers", default: [] } } },
  },
  errors: { bid_exists: "already_exists" },
  sample: { query: "video" },
};

const SERVER = {
  browse_jobs: (args: Record<string, unknown>) => ({
    jobs: [
      {
        id: 7,
        title: `Edit a ${args.search} clip`,
        poster: { name: "Ana" },
        asking_price: 40,
        description: "<p>Cut it to 30 s</p>",
        created_at: "2026-10-18T00:00:00Z",
        category: "video",
        location: "Anywhere",
      },
      {
        id: 8,
        title: "Translate a page",
        poster: { name: "Bo" },
        asking_price: 15,
        description: "English to Twi",
        created_at: "2026-10-17T00:00:00Z",
        category: "text",
      },
      { title: "broken row without id" },
    ],
    pagination: { has_more: true },
  }),
  get_job: (args: Record<string, unknown>) =>
    args.job_id === "7"
      ? { job: { id: 7, title: "Edit a clip", description: "Cut it to 30 s" } }
      : { error: "job_not_found", message: "No job 99" },
  submit_bid: (args: Record<string, unknown>) =>
    args.job_id === "7"
      ? { bid: { id: "bid-1", job_id: 7, amount: args.amount, description: args.description } }
      : { error: "bid_exists", message: "One bid per job." },
  request_close: () => ({ ok: true }),
  get_my_jobs: () => ({
    rows: [
      { job_id: 7, title: "Edit a clip", status: "close_requested" },
      { job_id: 3, title: "Old one", status: "completed" },
    ],
  }),
  get_my_payments: () => ({
    available_cents: 1250,
    transfers: [
      { id: "tr_1", amount_cents: 1250, state: "pending", job_title: "Edit a clip" },
      { id: "tr_0", amount_cents: 500, state: "paid" },
    ],
  }),
  get_me: () => ({ username: "ama", can_bid: true, blockers: [] }),
};

function setup(profile: McpProfile = PROFILE) {
  const fake = createFakeMcp(SERVER, { requireAuth: ["submit_bid", "request_close", "get_my_jobs", "get_my_payments", "get_me"] });
  const pool = new McpClientPool({ transportFactory: fake.transportFactory });
  const connector = defineMcpConnector(profile, { pool });
  const ctx = (key?: string) => testContext({ credentials: { FAKE_MARKET_KEY: key } });
  return { fake, pool, connector, ctx };
}

describe("profile schema and argument building", () => {
  it("validates profiles and explains mistakes", () => {
    expect(McpProfileSchema.safeParse(PROFILE).success).toBe(true);
    const bad = McpProfileSchema.safeParse({ ...PROFILE, tools: { search: { name: "x", items: "jobs", map: {} } } });
    expect(bad.success).toBe(false);
    expect(() => defineMcpConnector({ ...PROFILE, id: "Bad Id" })).toThrow(/Invalid MCP profile/u);
  });

  it("builds arguments from the input scope", () => {
    const args = buildArgs(
      {
        q: "$.query",
        status: "open",
        limit: { from: "$.limit", transform: "int" },
        remote: { from: "$.remote", transform: "bool" },
        skip: "$.missing",
      },
      { query: "dev", limit: "5", remote: "true" },
      "X",
    );
    expect(args).toEqual({ q: "dev", status: "open", limit: 5, remote: true });
    expect(buildArgs({ country: { from: "$.location", transform: "last" } }, { location: "Accra, Ghana" }, "X")).toEqual({
      country: "Ghana",
    });
    expect(buildArgs({ places: { from: "$.location", transform: "list" } }, { location: "Berlin, Remote ," }, "X")).toEqual({
      places: ["Berlin", "Remote"],
    });
    expect(buildArgs({ tags: { from: "$.query", transform: "csv" } }, { query: ["a", "b"] }, "X")).toEqual({ tags: "a,b" });
    expect(() => buildArgs({ email: { from: "$.answers.email", required: true } }, { answers: {} }, "Speedrun")).toThrow(
      /needs email: give it as answers.email/u,
    );
  });

  it("rejects application maps that use fields an application has no room for", () => {
    const list = {
      name: "get_my_jobs",
      args: {},
      items: "$.jobs",
      map: { id: "$.id", stage: { const: "applied" }, expires_at: "$.deadline" },
    };
    expect(() => defineMcpConnector({ ...PROFILE, tools: { ...PROFILE.tools, list } })).toThrow(/tools\.list\.map .*expires_at/u);
  });
});

describe("a profile-driven connector", () => {
  const { fake, connector, ctx } = setup();

  it("derives its stages and auth from the profile", () => {
    expect(stagesOf(connector)).toEqual(["search", "get", "apply", "submit", "status", "list", "account", "earnings"]);
    expect(connector.auth).toEqual({
      type: "api_key",
      env: ["FAKE_MARKET_KEY"],
      help: "Keys at https://fake.example/keys",
      required: false,
    });
  });

  it("searches anonymously, maps rows, templates urls, skips broken rows and applies client-side filters", async () => {
    const out = await connector.search!({ query: "video", limit: 5 }, ctx());
    expect(fake.lastCall("browse_jobs")?.args).toEqual({ search: "video", status: "open", limit: 5 });
    expect(out.more).toBe(true);
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs[0]).toMatchObject({
      id: "7",
      kind: "task",
      title: "Edit a video clip",
      org: "Ana",
      pay: { text: "USD 40", min: 40, currency: "USD" },
      url: "https://fake.example/jobs/7",
      posted_at: "2026-10-18T00:00:00Z",
      tags: ["video"],
      location: { remote: true },
    });
    const filtered = await connector.search!({ query: "video", location: "anywhere" }, ctx());
    expect(filtered.jobs.map((j) => j.id)).toEqual(["7", "8"]);
  });

  it("gets one job through its root path and answers null or not_found", async () => {
    const job = await connector.get!("7", ctx());
    expect(job).toMatchObject({ id: "7", title: "Edit a clip", description: "Cut it to 30 s", url: "https://fake.example/jobs/7" });
    await expect(connector.get!("99", ctx())).rejects.toMatchObject({ code: "not_found" });
  });

  it("gates writes behind the credential and names missing arguments", async () => {
    await expect(connector.apply!("7", { answers: { amount: "40" } }, ctx())).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("fake.example/keys"),
    });
    await expect(connector.apply!("7", {}, ctx("k"))).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("answers.amount"),
    });
  });

  it("applies, submits, reads status, lists, reports earnings and the account", async () => {
    const applied = await connector.apply!("7", { answers: { amount: "40" }, note: "Can start today" }, ctx("k"));
    expect(fake.lastCall("submit_bid")?.args).toEqual({ job_id: "7", amount: 40, description: "Can start today" });
    expect(fake.lastCall("submit_bid")?.headers.authorization).toBe("Bearer k");
    expect(applied).toMatchObject({ id: "7", job_id: "7", stage: "applied", url: "https://fake.example/jobs/7" });
    await expect(connector.apply!("8", { answers: { amount: "15" } }, ctx("k"))).rejects.toMatchObject({ code: "already_exists" });

    const submitted = await connector.submit!("7", { note: "done" }, ctx("k"));
    expect(submitted).toMatchObject({ id: "7", stage: "in_review", job_title: "Edit a clip" });
    expect((await connector.status!("7", ctx("k")))?.stage).toBe("in_review");
    expect(await connector.status!("42", ctx("k"))).toBeNull();
    const mine = await connector.list!(ctx("k"));
    expect(mine.map((a) => [a.id, a.stage])).toEqual([
      ["7", "closed"],
      ["3", "accepted"],
    ]);

    const earnings = await connector.earnings!(ctx("k"));
    expect(earnings.balance).toEqual({ amount: 1250, currency: "USD" });
    expect(earnings.entries).toEqual([
      { id: "tr_1", amount: 1250, currency: "USD", status: "pending", job_title: "Edit a clip" },
      { id: "tr_0", amount: 500, currency: "USD", status: "paid" },
    ]);
    expect(earnings.methods).toEqual(["stripe"]);
    expect(await connector.account!(ctx())).toMatchObject({ signed_in: false, help: expect.stringContaining("fake.example/keys") });
    expect(await connector.account!(ctx("k"))).toMatchObject({ signed_in: true, label: "ama", ready: true, missing: [] });
  });

  it("supports synthetic applications and JSON-in-text results", async () => {
    const textFake = createFakeMcp({
      list_bounties: () => ({ text: JSON.stringify({ bounties: [{ id: "b1", title: "Fix it", reward_usd: 5 }] }) }),
    });
    const bounty = defineMcpConnector(
      {
        id: "bounties",
        name: "Bounties",
        description: "d",
        kinds: ["task"],
        transport: { type: "http", url: "https://b.example/mcp" },
        tools: {
          search: {
            name: "list_bounties",
            args: {},
            items: "$.bounties",
            map: {
              id: "$.id",
              title: "$.title",
              "pay.min": "$.reward_usd",
              "pay.currency": { const: "USD" },
              "pay.period": { const: "unit" },
            },
          },
          apply: { synthetic: true, next: "Put the result in note and call submit_work." },
        },
      },
      { pool: new McpClientPool({ transportFactory: textFake.transportFactory }) },
    );
    const found = await bounty.search!({}, testContext());
    expect(found.jobs[0]).toMatchObject({ id: "b1", pay: { min: 5, currency: "USD", period: "unit" } });
    expect(await bounty.apply!("b1", {}, testContext())).toEqual({
      id: "b1",
      job_id: "b1",
      stage: "work_needed",
      next: "Put the result in note and call submit_work.",
    });
  });

  it("requires the credential everywhere when the profile says so", async () => {
    const strict = defineMcpConnector(
      { ...PROFILE, id: "strict", auth: { type: "bearer", env: "STRICT_KEY", help: "Get one.", required: true } },
      { pool: new McpClientPool({ transportFactory: fake.transportFactory }) },
    );
    expect(strict.auth).toMatchObject({ type: "api_key", required: true });
    await expect(strict.search!({ query: "x" }, testContext())).rejects.toMatchObject({ code: "auth_required" });
  });
});

describe("draftProfile", () => {
  it("guesses stages, arguments and fields from tools and a sample", () => {
    const tools: Tool[] = [
      {
        name: "search_jobs",
        description: "",
        inputSchema: { type: "object" as const, properties: { query: {}, location: {}, limit: {} } },
      },
      { name: "get_job", description: "", inputSchema: { type: "object" as const, properties: { job_id: {} } } },
      { name: "express_interest", description: "", inputSchema: { type: "object" as const, properties: { job_id: {}, email: {} } } },
      { name: "get_my_applications", description: "", inputSchema: { type: "object" as const, properties: {} } },
      { name: "get_me", description: "", inputSchema: { type: "object" as const, properties: {} } },
    ];
    const draft = draftProfile({
      id: "acme",
      url: "https://mcp.acme.com/mcp",
      tools,
      sampleSearch: { jobs: [{ id: "1", title: "Dev", company: "Acme", url: "https://acme.com/1", location: "Lagos" }] },
    });
    expect(draft.tools.search).toMatchObject({
      name: "search_jobs",
      args: { query: "$.query", location: "$.location", limit: "$.limit" },
      items: "$.jobs",
      map: { id: "$.id", title: "$.title", org: "$.company", url: "$.url", "location.text": "$.location" },
    });
    expect(draft.tools.get).toMatchObject({ name: "get_job", args: { job_id: "$.id" } });
    expect(draft.tools.apply).toMatchObject({ name: "express_interest" });
    expect(draft.tools.list).toMatchObject({ name: "get_my_applications" });
    expect(draft.tools.account).toMatchObject({ name: "get_me" });
    expect(draft.homepage).toBe("https://acme.com");
    expect(McpProfileSchema.safeParse(draft).success).toBe(true);
  });

  it("prefers the job search over a company search, reads camelCase arguments and lists array filters", () => {
    const tools: Tool[] = [
      {
        name: "search_listings",
        description: "Companies",
        inputSchema: { type: "object" as const, properties: { searchQuery: {} } },
      },
      {
        name: "search_jobs",
        description: "Roles",
        inputSchema: {
          type: "object" as const,
          properties: { searchQuery: { type: "string" }, location: { type: "array" }, pageSize: { type: "number" } },
        },
      },
    ];
    const draft = draftProfile({ id: "remote-board", url: "https://mcp.remote-board.example/mcp", tools });
    expect(draft.tools.search).toMatchObject({
      name: "search_jobs",
      args: { searchQuery: "$.query", location: { from: "$.location", transform: "list" }, pageSize: "$.limit" },
    });
    expect(McpProfileSchema.safeParse(draft).success).toBe(true);
  });
});

describe("renderProfileModule and writeDraft", () => {
  it("writes a profile module and an index for a drafted profile", () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "work-draft-")), "fake-market");
    const written = writeDraft(dir, PROFILE, { importFrom: "../../core/mcp/profile.js", source: "https://fake.example/mcp" });
    expect(written.map((f) => path.basename(f))).toEqual(["profile.ts", "index.ts"]);
    const source = readFileSync(path.join(dir, "profile.ts"), "utf8");
    expect(source).toContain('import type { McpProfileInput } from "../../core/mcp/profile.js";');
    expect(source).toContain("from https://fake.example/mcp");
    expect(source).toContain('"id": "fake-market"');
    expect(source.trimEnd().endsWith("satisfies McpProfileInput;")).toBe(true);
    expect(readFileSync(path.join(dir, "index.ts"), "utf8")).toContain("export const fakeMarket = defineMcpConnector(profile);");
    expect(writeDraft(dir, PROFILE)).toHaveLength(1);
    expect(renderProfileModule(PROFILE)).toContain('from "kariaa-agents"');
    expect(camelId("agent-bounty-board")).toBe("agentBountyBoard");
  });
});
