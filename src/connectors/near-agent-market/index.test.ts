import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, jsonResponse, testContext } from "../../core/conformance.js";
import { bidToApplication, createNearAgentMarket, jobToNative, nearAgentMarket, toApplication, type Held } from "./index.js";

type Rec = Record<string, unknown>;
type Call = { url: string; init?: RequestInit };
type State = { items: Rec[]; bids: Rec[]; delivered: Set<string>; reserved: number };

// Hand-made in the shapes of https://market.near.ai/openapi.json (2.0.0): every job read needs an agent token.
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Rec;
const board = load("board.json");
const job = load("job.json");
const assignments = load("assignments.json");
const bids = load("bids.json");
const entries = load("entries.json");
const reserve = load("reserve.json");

const TOKEN = "aat_0123456789abcdef0123456789abcdef";
const CREDS = { NEAR_AGENT_MARKET_TOKEN: TOKEN };
const JOB_A = "3f5b8c1e-2a4d-4e6f-8b9a-0c1d2e3f4a5b"; // open, takes bids
const JOB_B = "7c2e9d4f-1b3a-4c5e-9f8d-2a1b3c4d5e6f"; // open competition
const JOB_D = "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a"; // awarded to the agent, not started
const JOB_E = "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b"; // delivered, in review
const JOB_F = "f3a4b5c6-d7e8-4f9a-8b1c-2d3e4f5a6b7c"; // competition entry, judged without a prize
const JOB_G = "a4b5c6d7-e8f9-4a0b-9c1d-2e3f4a5b6c7d"; // pending bid
const JOB_H = "c5d6e7f8-a9b0-4c1d-8e2f-3a4b5c6d7e8f"; // rejected bid
const ASSIGNMENT_D = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const FILE = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
const FILE_URL = "https://market.near.ai/files/q8Zt2LmN4xVb/datasets.csv";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const AGENT = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fresh = () => createNearAgentMarket({ workFile: path.join(mkdtempSync(path.join(os.tmpdir(), "near-market-")), "work.json") });
const ctxOf = (fetch: typeof globalThis.fetch, credentials: Record<string, string> = CREDS) => testContext({ fetch, credentials });

/** The agent's side of the market, changed by each write the way the API reference describes. */
function market(
  calls: Call[] = [],
  refuse: (url: string, init: RequestInit | undefined, state: State) => Response | undefined = () => undefined,
) {
  const state: State = {
    items: clone(assignments.assignments as Rec[]),
    bids: clone(bids.bids as Rec[]),
    delivered: new Set(),
    reserved: 0,
  };
  const fetch = fixtureFetch((url, init) => {
    calls.push({ url, init });
    const refused = refuse(url, init, state);
    if (refused) return refused;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.startsWith("https://objects.example/")) return new Response(null, { status: 200 });
    if (headers.authorization !== `Bearer ${TOKEN}`) return jsonResponse({ error: "unauthorized", message: "unauthorized" }, 401);
    const { pathname } = new URL(url);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Rec) : {};
    if (pathname === "/v1/jobs/board") return board;
    if (pathname === "/v1/agents/me/assignments") return { assignments: state.items };
    if (pathname === "/v1/agents/me/bids") return { bids: state.bids, total: state.bids.length };
    if (pathname === "/v1/me") {
      return {
        account: {
          account_id: "4f5e6d7c-8b9a-4f0e-8d1c-2b3a4f5e6d7c",
          display_name: "Copy Fox Studio",
          slug: "copyfox",
          kyc_status: "none",
          is_verified: false,
          payout_schedule: "weekly",
          created_at: "2026-09-01T10:00:00Z",
        },
        tos_accepted: false,
        skill_verification_enforcement: "required",
        user: null,
      };
    }
    if (method === "GET" && pathname === `/v1/jobs/${JOB_A}`) return job;
    if (method === "GET" && pathname === `/v1/jobs/${JOB_B}`) return (board.jobs as Rec[])[1];
    if (method === "GET" && pathname === `/v1/jobs/${JOB_G}`)
      return { jobId: JOB_G, title: "Summarize ten support tickets", budgetToken: "USDC" };
    if (method === "GET" && pathname === `/v1/jobs/${JOB_F}/entries`) return entries;
    if (method === "POST" && pathname === `/v1/jobs/${JOB_A}/bids`) {
      const bid = {
        bidId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
        jobId: JOB_A,
        bidderAgentId: AGENT,
        amount: `${String(body.amount)}0000000000`,
        proposal: body.proposal,
        slaSeconds: body.slaSeconds ?? null,
        verifiableOffered: false,
        status: "pending",
        createdAt: "2026-10-20T12:00:00Z",
        updatedAt: "2026-10-20T12:00:00Z",
      };
      state.bids.unshift(bid);
      return jsonResponse(bid, 201);
    }
    if (method === "POST" && pathname === `/v1/jobs/${JOB_B}/entries`) {
      const assignment = {
        assignmentId: "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a",
        jobId: JOB_B,
        workerAgentId: AGENT,
        bidId: null,
        status: "in_progress",
        escrowAmount: "0",
        escrowToken: "USDC",
        slaSeconds: 0,
        slaDeadlineAt: "2026-10-27T18:00:00Z",
        acceptanceWindowDays: 3,
        startedAt: null,
        submittedAt: null,
        createdAt: "2026-10-20T12:00:00Z",
        updatedAt: "2026-10-20T12:00:00Z",
      };
      return jsonResponse(assignment, 201);
    }
    const work = /^\/v1\/assignments\/([0-9a-f-]+)\/(start|submit)$/u.exec(pathname);
    if (method === "POST" && work) {
      const item = state.items.find((i) => (i.assignment as Rec).assignmentId === work[1]);
      if (!item) return jsonResponse({ error: "not_found" }, 404);
      const a = item.assignment as Rec;
      if (work[2] === "start") {
        a.startedAt ??= "2026-10-20T12:00:00Z";
        return { startedAt: a.startedAt };
      }
      for (const file of (body.files as string[] | undefined) ?? []) state.delivered.add(file);
      Object.assign(a, {
        status: "submitted",
        submittedAt: "2026-10-20T13:00:00Z",
        deliverableUrl: `deliverables/${String(a.assignmentId)}/v1.md`,
      });
      item.autoAcceptAt = "2026-10-23T13:00:00Z";
      return a;
    }
    if (method === "POST" && pathname === "/v1/files") {
      state.reserved = Number(body.byteSize);
      return jsonResponse({ ...reserve, byteSize: body.byteSize }, 201);
    }
    if (method === "POST" && pathname === `/v1/files/${FILE}/complete`) {
      return {
        fileId: FILE,
        filename: "datasets.csv",
        byteSize: state.reserved,
        sha256: "c0ffee".padEnd(64, "0"),
        contentType: "text/csv",
      };
    }
    if (method === "DELETE" && pathname === `/v1/files/${FILE}`) {
      return state.delivered.has(FILE_URL)
        ? jsonResponse({ error: "file_bound", message: "The file is part of a delivered version." }, 409)
        : new Response(null, { status: 204 });
    }
    if (pathname.startsWith("/v1/jobs/") || pathname.startsWith("/v1/files/")) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ error: "internal" }, 500);
  });
  return { fetch, state };
}

describeConnectorConformance(nearAgentMarket, { search: { query: "datasets" }, fetch: market().fetch, credentials: CREDS, minResults: 3 });

describe("near-agent-market", () => {
  it("maps board rows: bids, competitions, slots and badges", async () => {
    const calls: Call[] = [];
    const { fetch } = market(calls);
    const { jobs, more } = await nearAgentMarket.search!({ query: "datasets", limit: 2 }, ctxOf(fetch));
    expect(calls[0]!.url).toBe("https://market.near.ai/v1/jobs/board?q=datasets&limit=3");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(jobs).toHaveLength(2);
    expect(more).toBe(true);
    expect(jobs[0]).toMatchObject({
      id: JOB_A,
      kind: "task",
      title: "Research brief: 20 public datasets on EV charging in Europe",
      org: "Volt Atlas",
      location: { remote: true },
      pay: { max: 40, currency: "USD", period: "unit", unit: "per job", text: "Budget 40 USD" },
      url: `https://market.near.ai/jobs/${JOB_A}`,
      posted_at: "2026-10-19T14:02:11.483Z",
    });
    expect(jobs[0]!.tags).toEqual(["bid", "research", "data", "agent-allowed", "source:near-agent-market"]);
    expect(jobs[0]!.requirements?.questions?.map((q) => q.id)).toEqual(["amount", "delivery_hours"]);
    expect(jobs[0]!.stages).toBeUndefined();
    expect(jobs[1]).toMatchObject({
      id: JOB_B,
      pay: { max: 150, currency: "USDC", period: "unit", unit: "prize pool, split among the best works", text: "150 USDC prize pool" },
      expires_at: "2026-10-27T18:00:00.000Z",
    });
    expect(jobs[1]!.tags).toEqual(["competition", "writing", "education", "agent-allowed", "source:near-agent-market"]);
    expect(jobs[1]!.apply_hint).toContain("before 2026-10-27 18:00 UTC");
    expect(jobs[1]!.requirements?.questions).toBeUndefined();
    const all = await nearAgentMarket.search!({}, ctxOf(fetch));
    expect(calls[1]!.url).toBe("https://market.near.ai/v1/jobs/board?limit=21");
    expect(all.more).toBe(false);
    const third = all.jobs[2]!;
    expect(third.pay).toBeUndefined();
    expect(third.tags).toEqual([
      "bid",
      "dev_tools",
      "testing",
      "typescript",
      "needs-verified-builder",
      "2 of 3 slots free",
      "agent-allowed",
      "source:near-agent-market",
    ]);
    expect(third.apply_hint).toContain("Needs a verified builder badge");
  });

  it("needs the token, and asks nothing for listings", async () => {
    const calls: Call[] = [];
    const { fetch } = market(calls);
    await expect(nearAgentMarket.search!({ query: "x" }, ctxOf(fetch, {}))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("NEAR_AGENT_MARKET_TOKEN"),
    });
    expect(await nearAgentMarket.search!({ kind: "listing" }, ctxOf(fetch))).toEqual({ jobs: [] });
    expect(calls).toHaveLength(0);
    const revoked = market([], () => jsonResponse({ error: "unauthorized" }, 401)).fetch;
    await expect(nearAgentMarket.search!({ query: "x" }, ctxOf(revoked))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("refused the token"),
    });
  });

  it("reads one job; a job past bidding drops apply", async () => {
    const { fetch } = market();
    const one = await nearAgentMarket.get!(JOB_A, ctxOf(fetch));
    expect(one).toMatchObject({ id: JOB_A, org: "Volt Atlas" });
    expect(one!.description).toContain("## What counts");
    expect(one!.summary!.length).toBeLessThanOrEqual(301);
    expect(await nearAgentMarket.get!("not-a-job", ctxOf(fetch))).toBeNull();
    await expect(nearAgentMarket.get!(UNKNOWN, ctxOf(fetch))).rejects.toMatchObject({ code: "not_found" });
    const row = (board.jobs as Rec[])[0]!;
    expect(jobToNative({ ...row, status: "in_progress" })!.stages).toEqual(["get", "upload", "remove", "submit", "status", "link"]);
    expect(jobToNative({ ...row, status: "completed" })!.stages).toEqual(["get", "status", "link"]);
    expect(jobToNative({ jobId: JOB_A })).toBeNull();
  });

  it("bids in the documented shape, and answers the same bid twice", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const { fetch } = market(calls);
    const ctx = ctxOf(fetch);
    await expect(connector.apply!(JOB_A, { note: "Hi" }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("answers.amount"),
    });
    await expect(connector.apply!(JOB_A, { answers: { amount: "40" } }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("note"),
    });
    await expect(connector.apply!(JOB_A, { answers: { amount: "40", delivery_hours: "1000" }, note: "Hi" }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("delivery_hours"),
    });
    await expect(connector.apply!("nope", { note: "Hi" }, ctx)).rejects.toMatchObject({ code: "not_found" });
    calls.length = 0;
    const note = "Twenty sources from EU and national portals, as a table and a CSV.";
    const app = await connector.apply!(JOB_A, { answers: { amount: "40", delivery_hours: "48" }, note }, ctx);
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(`https://market.near.ai/v1/jobs/${JOB_A}/bids`);
    expect(posts[0]!.init!.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": expect.stringContaining("work-protocol/"),
    });
    expect(JSON.parse(String(posts[0]!.init!.body))).toEqual({ amount: "40.00", proposal: note, slaSeconds: 172800 });
    expect(app).toMatchObject({
      id: JOB_A,
      job_id: JOB_A,
      job_title: "Research brief: 20 public datasets on EV charging in Europe",
      stage: "applied",
      url: `https://market.near.ai/jobs/${JOB_A}`,
      created_at: "2026-10-20T12:00:00.000Z",
      raw: { bid_id: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", sla_seconds: 172800 },
    });
    expect(app.next).toContain("Bid of 40 USD placed");
    calls.length = 0;
    expect(await connector.apply!(JOB_A, { answers: { amount: "45" }, note: "Again" }, ctx)).toMatchObject({ id: JOB_A, stage: "applied" });
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });

  it("takes the price from preferred_rate and returns the held bid on duplicate_bid", async () => {
    const calls: Call[] = [];
    const { fetch } = market(calls, (url, init, state) => {
      if (init?.method !== "POST" || !url.endsWith(`/jobs/${JOB_A}/bids`)) return undefined;
      state.bids.unshift({ ...(bids.bids as Rec[])[1], jobId: JOB_A });
      return jsonResponse({ error: "duplicate_bid", message: "duplicate_bid" }, 409);
    });
    const app = await fresh().apply!(JOB_A, { preferred_rate: "$42.5", note: "Hi" }, ctxOf(fetch));
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ amount: "42.50" });
    expect(app).toMatchObject({ id: JOB_A, stage: "applied", job_title: "Research brief: 20 public datasets on EV charging in Europe" });
    expect(app.next).toContain("Bid of 18.5 USD placed");
  });

  it("enters a competition with an empty body", async () => {
    const calls: Call[] = [];
    const { fetch } = market(calls);
    const app = await fresh().apply!(JOB_B, {}, ctxOf(fetch));
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe(`https://market.near.ai/v1/jobs/${JOB_B}/entries`);
    expect(post.init!.body).toBe("{}");
    expect(app).toMatchObject({
      id: JOB_B,
      stage: "work_needed",
      job_title: "Competition: the clearest one-page explainer of account abstraction",
      raw: { assignment_id: "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a", bid_id: null },
    });
    expect(app.next).toContain("before 2026-10-27 18:00 UTC");
  });

  it("declares the start when applying again after an award", async () => {
    const calls: Call[] = [];
    const { fetch } = market(calls);
    const app = await fresh().apply!(JOB_D, {}, ctxOf(fetch));
    const posts = calls.filter((c) => c.init?.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([`https://market.near.ai/v1/assignments/${ASSIGNMENT_D}/start`]);
    expect(posts[0]!.init!.body).toBeUndefined();
    expect(app).toMatchObject({ id: JOB_D, stage: "work_needed", job_title: "Clean and deduplicate a list of 2,000 bookshop addresses" });
    expect(app.next).toContain("Awarded and started (25 USD in escrow)");
    expect(app.next).toContain("by 2026-10-22 10:00 UTC");
  });

  it("adds a file and text, delivers them, and keeps the files for the next version", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const { fetch, state } = market(calls);
    const ctx = ctxOf(fetch);
    const bytes = new TextEncoder().encode("name,publisher\nEVCS,EU Open Data\n");
    const receipt = await connector.upload!(JOB_D, { kind: "file", name: "datasets.csv", mime_type: "text/csv", bytes }, ctx);
    const reserved = calls.find((c) => c.url === "https://market.near.ai/v1/files")!;
    expect(reserved.init!.method).toBe("POST");
    expect(JSON.parse(String(reserved.init!.body))).toEqual({ filename: "datasets.csv", byteSize: bytes.byteLength, link: true });
    const put = calls.find((c) => c.url.startsWith("https://objects.example/"))!;
    expect(put.url).toBe(String(reserve.directUploadUrl));
    expect(put.init!.method).toBe("PUT");
    expect(put.init!.body).toBe(bytes);
    expect(put.init!.headers).not.toHaveProperty("authorization");
    expect(put.init!.signal).toBe(ctx.signal);
    expect(calls.find((c) => c.url === `https://market.near.ai/v1/files/${FILE}/complete`)!.init!.method).toBe("POST");
    expect(calls.some((c) => c.url === `https://market.near.ai/v1/assignments/${ASSIGNMENT_D}/start`)).toBe(true);
    expect(receipt.file).toEqual({ id: FILE, name: "datasets.csv", kind: "file", size: bytes.byteLength });
    expect(receipt.next).toContain("declared started");
    await expect(connector.upload!(JOB_D, { kind: "file", name: "copy.csv", mime_type: "text/csv", bytes }, ctx)).rejects.toMatchObject({
      code: "already_exists",
      details: { file: { id: FILE } },
    });
    const table = "| name | publisher |\n| EVCS | EU Open Data |";
    const text = await connector.upload!(JOB_D, { kind: "text", text: table }, ctx);
    expect(text.file).toMatchObject({ id: "text-1", kind: "text" });
    expect(text.files?.map((f) => f.id)).toEqual(["text-1", FILE]);
    expect(text.next).not.toContain("declared started");
    calls.length = 0;
    const app = await connector.submit!(JOB_D, { note: "Twenty datasets: the table below, and the CSV." }, ctx);
    const submit = calls.find((c) => c.url === `https://market.near.ai/v1/assignments/${ASSIGNMENT_D}/submit`)!;
    expect(submit.init!.method).toBe("POST");
    expect(JSON.parse(String(submit.init!.body))).toEqual({
      deliverableMarkdown: `Twenty datasets: the table below, and the CSV.\n\n${table}`,
      files: [FILE_URL],
    });
    expect(app).toMatchObject({ id: JOB_D, stage: "in_review", files: [{ id: FILE, name: "datasets.csv", kind: "file" }] });
    expect(state.delivered.has(FILE_URL)).toBe(true);
    const after = await connector.status!(JOB_D, ctx);
    expect(after).toMatchObject({ stage: "in_review", files: [{ id: FILE }] });
    expect(after!.next).toContain("silence accepts it on 2026-10-23 13:00 UTC");
    const removed = await connector.remove!(JOB_D, FILE, ctx);
    expect(removed).toMatchObject({ removed: { id: FILE, name: "datasets.csv" }, files: [] });
    expect(removed.next).toContain("leaves it out");
  });

  it("removes added work before delivery", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const { fetch } = market(calls);
    const ctx = ctxOf(fetch);
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    await connector.upload!(JOB_D, { kind: "file", name: "datasets.csv", mime_type: "text/csv", bytes }, ctx);
    await connector.upload!(JOB_D, { kind: "text", text: "draft" }, ctx);
    const gone = await connector.remove!(JOB_D, FILE, ctx);
    const del = calls.find((c) => c.init?.method === "DELETE")!;
    expect(del.url).toBe(`https://market.near.ai/v1/files/${FILE}`);
    expect(gone).toMatchObject({ removed: { id: FILE }, files: [{ id: "text-1" }] });
    expect(gone.next).toContain("Deleted");
    expect((await connector.remove!(JOB_D, "text-1", ctx)).files).toEqual([]);
    await expect(connector.remove!(JOB_D, "text-9", ctx)).rejects.toMatchObject({ code: "not_found" });
    await expect(connector.submit!(JOB_D, {}, ctx)).rejects.toMatchObject({ code: "not_ready" });
  });

  it("refuses work before an award and after the end", async () => {
    const connector = fresh();
    const { fetch } = market();
    const ctx = ctxOf(fetch);
    await expect(connector.upload!(JOB_G, { kind: "text", text: "x" }, ctx)).rejects.toMatchObject({
      code: "not_ready",
      message: expect.stringContaining("not awarded"),
    });
    await expect(connector.submit!(JOB_H, { note: "x" }, ctx)).rejects.toMatchObject({ code: "wrong_stage" });
    await expect(connector.submit!(JOB_F, { note: "x" }, ctx)).rejects.toMatchObject({
      code: "wrong_stage",
      details: { stage: "cancelled" },
    });
    await expect(connector.submit!(UNKNOWN, { note: "x" }, ctx)).rejects.toMatchObject({
      code: "not_ready",
      message: expect.stringContaining("apply_to_job"),
    });
    await expect(connector.submit!(JOB_D, { note: "x".repeat(256 * 1024 + 1) }, ctx)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("follows every bid and assignment", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const { fetch } = market(calls);
    const ctx = ctxOf(fetch);
    const mine = await connector.list!(ctx);
    expect(mine.map((a) => [a.id, a.stage])).toEqual([
      [JOB_D, "work_needed"],
      [JOB_E, "in_review"],
      [JOB_F, "rejected"],
      [JOB_G, "applied"],
      [JOB_H, "rejected"],
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://market.near.ai/v1/agents/me/assignments?status=all&limit=100&offset=0",
      "https://market.near.ai/v1/agents/me/bids?status=all&limit=100&offset=0",
      `https://market.near.ai/v1/jobs/${JOB_G}`,
      `https://market.near.ai/v1/jobs/${JOB_H}`,
    ]);
    // A bid has no title of its own: it comes from the job, and a job that can't be read leaves it out.
    expect(mine.find((a) => a.id === JOB_G)!.job_title).toBe("Summarize ten support tickets");
    expect(mine.find((a) => a.id === JOB_H)).not.toHaveProperty("job_title");
    expect(mine[0]!.next).toContain("Call apply_to_job again to declare the start");
    const review = await connector.status!(JOB_E, ctx);
    expect(review).toMatchObject({
      stage: "in_review",
      job_title: "Translate a 1,500-word onboarding guide into Spanish",
      raw: { escrow_amount: "60.000000000000", auto_accept_at: "2026-10-23T09:30:00.000Z" },
    });
    expect(review!.next).toContain("silence accepts it on 2026-10-23 09:30 UTC");
    const judged = await connector.status!(JOB_F, ctx);
    expect(judged).toMatchObject({ stage: "rejected", review: { note: expect.stringContaining("pricing section") }, raw: { score: 61 } });
    expect(judged!.next).toContain("Scored 61/100");
    const pending = await connector.status!(JOB_G, ctx);
    expect(pending).toMatchObject({
      id: JOB_G,
      stage: "applied",
      raw: { bid_id: "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d", sla_seconds: 7200 },
    });
    expect(pending!.next).toContain("Bid of 18.5 USDC placed");
    expect(await connector.status!("nope", ctx)).toBeNull();
    expect(await connector.status!(UNKNOWN, ctx)).toBeNull();
  });

  it("words each assignment state", () => {
    const base = (assignments.assignments as Rec[])[0]!;
    const a = base.assignment as Rec;
    const held = (patch: Rec, extra: Partial<Held> = {}): Held => ({ assignment: { ...a, ...patch }, job: base.job as Rec, ...extra });
    const started = { startedAt: "2026-10-20T11:00:00Z" };
    expect(
      toApplication(
        held(
          { ...started, submittedAt: "2026-10-20T12:00:00Z", deliverableUrl: "d/v1.md" },
          { latest: { senderSide: "buyer", body: "Add the postcode column." } },
        ),
      ).next,
    ).toContain("asked for changes. The buyer wrote: “Add the postcode column.”");
    expect(toApplication(held({ ...started, deliverableUrl: "d/v1.md", submittedAt: null })).next).toContain("redo");
    expect(toApplication(held({ status: "disputed" })).stage).toBe("in_review");
    expect(toApplication(held({ status: "dispute_resolved" })).stage).toBe("closed");
    expect(toApplication(held({ status: "accepted" }))).toMatchObject({
      stage: "accepted",
      next: expect.stringContaining("escrow of 25 USD"),
    });
    expect(toApplication(held({ status: "cancelled", cancelReason: "rejected" })).stage).toBe("withdrawn");
    expect(toApplication(held({ status: "cancelled", cancelReason: "agent_suspended" })).next).toContain("suspended");
    expect(toApplication(held({ status: "cancelled", cancelReason: "buyer_cancel", cancelDetail: "Never started." })).next).toBe(
      "Cancelled and the buyer refunded: Never started.",
    );
    const prize = toApplication({
      assignment: { ...a, status: "accepted", escrowAmount: "42.500000000000", escrowToken: "USDC", bidId: null },
      job: { ...(base.job as Rec), jobKind: "competition" },
    });
    expect(prize).toMatchObject({ stage: "accepted", next: expect.stringContaining("Won a share of the pool: 42.5 USDC") });
    expect(bidToApplication({ ...(bids.bids as Rec[])[1], status: "withdrawn" }).stage).toBe("withdrawn");
    expect(bidToApplication({ ...(bids.bids as Rec[])[1], status: "accepted" }).stage).toBe("work_needed");
  });

  it("maps the market's refusals", async () => {
    const refusing = (status: number, body: Rec, headers: Record<string, string> = {}) =>
      market([], (url, init) => (init?.method === "POST" && url.endsWith("/bids") ? jsonResponse(body, status, headers) : undefined)).fetch;
    const input = { answers: { amount: "40" }, note: "Hi" };
    const verify = { error: "builder_verification_required", message: "This job asks for a verified builder; your owner holds none." };
    await expect(fresh().apply!(JOB_A, input, ctxOf(refusing(400, verify)))).rejects.toMatchObject({
      code: "not_ready",
      message: expect.stringContaining("verified builder"),
      details: { status: 400, error: "builder_verification_required" },
    });
    const usd = { error: "usd_not_accepted", message: "usd_not_accepted" };
    await expect(fresh().apply!(JOB_A, input, ctxOf(refusing(400, usd)))).rejects.toMatchObject({
      code: "not_ready",
      message: expect.stringContaining("Stripe connected"),
      details: { status: 400, error: "usd_not_accepted" },
    });
    const cluster = { error: "cluster_already_in_job", message: "Your agent Copy Fox already has a live bid on this job." };
    await expect(fresh().apply!(JOB_A, input, ctxOf(refusing(409, cluster)))).rejects.toMatchObject({ code: "already_exists" });
    await expect(fresh().apply!(JOB_A, input, ctxOf(refusing(400, { error: "agent_paused", message: "paused" })))).rejects.toMatchObject({
      code: "not_ready",
    });
    await expect(
      fresh().apply!(JOB_A, input, ctxOf(refusing(429, { error: "rate_limited" }, { "retry-after": "30" }))),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retry_after: 30,
    });
    const invalid = { error: "validation_error", message: "proposal must not be empty" };
    await expect(fresh().apply!(JOB_A, input, ctxOf(refusing(400, invalid)))).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("proposal must not be empty"),
    });
    await expect(fresh().apply!(JOB_A, input, ctxOf(refusing(503, { error: "unavailable" })))).rejects.toMatchObject({
      code: "upstream_error",
    });
  });

  it("registers an agent without a token and returns the owner's adoption link", async () => {
    const calls: Call[] = [];
    const fetch = fixtureFetch((url, init) => {
      calls.push({ url, init });
      const auth = ((init?.headers ?? {}) as Record<string, string>).authorization;
      if (url.endsWith("/v1/agents/register")) {
        expect(auth).toBeUndefined();
        const body = JSON.parse(String(init!.body)) as Rec;
        return jsonResponse({ agentId: AGENT, accountId: UNKNOWN, handle: body.handle, apiToken: TOKEN, tokenPrefix: "aat_0123" }, 201);
      }
      if (url.endsWith("/v1/agents/me/adoption-code") && auth === `Bearer ${TOKEN}`) {
        return jsonResponse(
          { code: "ADOPT-1", adoptionUrl: "https://market.near.ai/adopt/ADOPT-1", expiresAt: "2026-11-05T10:00:00.000Z" },
          201,
        );
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    const done = await fresh().register!({ email: "Team.Kariaa@example.com", name: "Team Kariaa" }, ctxOf(fetch, {}));
    const sent = JSON.parse(String(calls[0]!.init!.body)) as Rec;
    expect(sent).toMatchObject({ name: "Team Kariaa", category: "other", email: "Team.Kariaa@example.com" });
    expect(String(sent.handle)).toMatch(/^team-kariaa-[0-9a-f]{8}$/u);
    expect(done.credentials).toEqual({ NEAR_AGENT_MARKET_TOKEN: TOKEN });
    expect(done.account_id).toBe(sent.handle);
    expect(done.next_step).toContain("https://market.near.ai/adopt/ADOPT-1");
    expect(done.next_step).toContain("2026-11-05 10:00 UTC");
    // With no name, the public handle is Kariaa's, never built from the email.
    await fresh().register!({ email: "private.person@example.com" }, ctxOf(fetch, {}));
    const bare = JSON.parse(String(calls.find((c, i) => i > 0 && c.url.endsWith("/v1/agents/register"))!.init!.body)) as Rec;
    expect(String(bare.handle)).toMatch(/^kariaa-agent-[0-9a-f]{8}$/u);
  });

  it("reads the account and links the job page", async () => {
    const calls: Call[] = [];
    const { fetch } = market(calls);
    expect(await nearAgentMarket.account!(ctxOf(fetch, {}))).toMatchObject({ signed_in: false, help: expect.stringContaining("aat_") });
    expect(await nearAgentMarket.account!(ctxOf(fetch))).toMatchObject({
      signed_in: true,
      label: "Copy Fox Studio",
      ready: true,
      profile: { verified: false, payout_schedule: "weekly" },
    });
    expect(calls.at(-1)!.url).toBe("https://market.near.ai/v1/me");
    const unadopted = market([], (url) => (url.endsWith("/v1/me") ? jsonResponse({ error: "unauthorized" }, 401) : undefined)).fetch;
    expect(await nearAgentMarket.account!(ctxOf(unadopted))).toMatchObject({
      signed_in: true,
      ready: true,
      profile: { adopted: false, verified: false },
      help: expect.stringContaining("USDC jobs and competitions work now"),
    });
    expect(await nearAgentMarket.link!(JOB_D, ctxOf(fetch))).toEqual({ url: `https://market.near.ai/jobs/${JOB_D}`, signed_in: false });
    await expect(nearAgentMarket.link!("nope", ctxOf(fetch))).rejects.toMatchObject({ code: "not_found" });
  });
});
