import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, jsonResponse, testContext } from "../../core/conformance.js";
import { bidToApplication, entryToApplication, firstLink, moneyOf, opentask, taskToJob } from "./index.js";

type Rec = Record<string, unknown>;
type Call = { url: string; init?: RequestInit };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Rec;
const TASK_PAGES: Record<string, Rec> = {
  python: fixture("tasks-python"),
  audit: fixture("tasks-audit"),
  docs: fixture("tasks-docs"),
};
const PAGE = fixture("tasks-page");
const TASK_DETAIL = fixture("task");
const COMPETITION = fixture("competition");

const TASK = "cmva5jxfs000y06kzcsyg7cxu";
const TASK_TITLE = "Post and fund a real task on Verdikta Bounties (Base), get it judged, publish a 300-word write-up — 30 USDC";
const COMP = "cmsulgbho008804jygehnzytv";
const BID_ID = "cmwbid7k2000a06l1x9f3q2ab";
const CONTRACT_ID = "cmwctr7k2000b06l1h4j8m3cd";
const INTENT_ID = "cmwupl7k2000c06l1q8w2e5fg";
const FILE_ID = "cmwfil7k2000d06l1z3x6c9hj";
const CREDS = { OPENTASK_API_TOKEN: "ot_test" };
const UPLOAD_URL = "https://uploads.example.com/r2/object?signature=abc";

/** Hand-made from the OpenAPI reference (not captured live: these need an account). */
const bidRow = (over: Rec = {}): Rec => ({
  id: BID_ID,
  priceText: "30 USDC",
  priceAmount: "30",
  priceCurrency: "USDC",
  etaDays: 5,
  approach: "I post a funded rubric task, get it judged and publish the write-up.",
  status: "active",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  task: { id: TASK, title: TASK_TITLE, status: "open", ownerHandle: "nigelon11" },
  contract: null,
  ...over,
});
const contractRow = (over: Rec = {}): Rec => ({
  id: CONTRACT_ID,
  source: "bid",
  status: "in_progress",
  settlementStatus: "unpaid",
  paymentVerificationStatus: "unpaid",
  createdAt: "2026-10-21T09:00:00.000Z",
  updatedAt: "2026-10-21T09:00:00.000Z",
  buyer: { id: "cmva42ofk00t306l31rj83fed", handle: "nigelon11", displayName: "nigelon11" },
  seller: { id: "cmwsel7k2000e06l1abcdefgh", handle: "ama-agent", displayName: "Ama" },
  task: { id: TASK, title: TASK_TITLE },
  bid: { id: BID_ID, priceText: "30 USDC", etaDays: 5 },
  taskAward: null,
  ...over,
});
const intentRow = (over: Rec = {}): Rec => ({
  id: INTENT_ID,
  fileId: FILE_ID,
  purpose: "contract_submission",
  status: "completed",
  fileStatus: "ready",
  filename: "report.md",
  contentType: "text/markdown",
  sizeBytes: 9,
  createdAt: "2026-10-22T09:00:00.000Z",
  expiresAt: "2026-10-22T09:15:00.000Z",
  pollAfterMs: null,
  upload: null,
  ...over,
});

type State = {
  bid?: Rec;
  contract?: Rec;
  mine?: Rec[];
  milestones?: Rec;
  intents?: Rec[];
  created?: Rec;
  entries?: Rec[];
  competition?: Rec;
  contracts?: Rec[];
  /** The actions the contract detail offers (prepare_delivery for native delivery). */
  contractActions?: Rec[];
  deliveries?: Rec[];
  /** The contract refuses ordinary submissions. */
  nativeOnly?: boolean;
  /** The body of a 409 the submission answers with. */
  submissionError?: Rec;
  /** What the submission answers instead of a new one. */
  submission?: Rec;
};

const PKG = "cmwpkg7k2000l06l1abcdefgh";
const draftRow = (over: Rec = {}): Rec => ({
  id: PKG,
  contractId: CONTRACT_ID,
  milestoneId: null,
  status: "draft",
  version: 1,
  revision: null,
  basedOnPackageId: null,
  artifacts: [],
  criteria: [
    { id: "crit-1", sequence: 1, text: "A task posted on bounties.verdikta.org after 14 Oct 2026", required: true, artifactIds: [] },
    { id: "crit-2", sequence: 2, text: "A public write-up of at least 300 words", required: true, artifactIds: [] },
  ],
  ...over,
});

const header = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];

function router(state: State = {}, calls: Call[] = []) {
  return fixtureFetch((url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (u.hostname === "uploads.example.com") return new Response(null, { status: 200 });
    if (u.pathname === "/api/tasks") {
      const q = u.searchParams.get("query");
      if (!q) return PAGE;
      return TASK_PAGES[q] ?? { tasks: [], nextCursor: null };
    }
    if (u.pathname === `/api/tasks/${TASK}`) return TASK_DETAIL;
    if (u.pathname === `/api/tasks/${COMP}`) return state.competition ?? COMPETITION;
    if (u.pathname.startsWith("/api/tasks/")) return jsonResponse({ error: "Not found" }, 404);
    if (header(init, "authorization") !== "Bearer ot_test") return jsonResponse({ error: "Unauthorized" }, 401);
    const path = u.pathname.replace(/^\/api/u, "");
    if (path === "/agent/bids" && method === "GET") return { bids: state.mine ?? [], nextCursor: null };
    if (path === `/agent/tasks/${TASK}/bids` && method === "POST") {
      return { bid: { id: BID_ID, status: "active", updatedAt: "2026-10-20T10:00:00.000Z", capabilityClaims: [] }, availableActions: [] };
    }
    if (path === `/agent/bids/${BID_ID}`) return { bid: state.bid ?? bidRow(), availableActions: [] };
    if (path === `/agent/contracts/${CONTRACT_ID}`) {
      return { contract: state.contract ?? contractRow(), availableActions: state.contractActions ?? [] };
    }
    if (path === "/agent/contracts") return { contracts: state.contracts ?? [], nextCursor: null };
    if (path === `/agent/contracts/${CONTRACT_ID}/milestones`) {
      return (
        state.milestones ?? {
          contractId: CONTRACT_ID,
          contractStatus: "in_progress",
          summary: { settlementMode: "single" },
          milestones: [],
        }
      );
    }
    if (path === `/agent/contracts/${CONTRACT_ID}/milestones/ms-0001/submit`)
      return { contractId: CONTRACT_ID, milestone: {}, replayed: false };
    const uploads = new RegExp(
      `^/agent/(contracts/${CONTRACT_ID}/submission-attachments|contracts/${CONTRACT_ID}/deliveries/${PKG}|tasks/${COMP}/entry-attachments)/upload-intents`,
      "u",
    );
    if (uploads.test(path)) {
      const rest = path.replace(uploads, "");
      if (rest === "" && method === "GET") return { uploadIntents: state.intents ?? [], nextCursor: null };
      if (rest === "" && method === "POST") {
        return (
          state.created ?? {
            uploadIntent: intentRow({
              status: "issued",
              fileStatus: "pending_upload",
              upload: {
                transport: "direct_r2",
                url: UPLOAD_URL,
                method: "PUT",
                callerHeaders: { "content-type": "text/markdown", "content-length": "9" },
                expiresAt: "2026-10-22T09:15:00.000Z",
                expectedContentLength: 9,
              },
            }),
            limits: {},
            pollAfterMs: null,
            replayed: false,
          }
        );
      }
      if (rest === `/${INTENT_ID}/complete`)
        return { file: { id: FILE_ID, uploadIntentId: INTENT_ID, status: "processing" }, pollAfterMs: 1500 };
      if (rest === `/${INTENT_ID}` && method === "DELETE") return { status: "canceled", file: { id: FILE_ID, filename: "report.md" } };
    }
    if (path === `/agent/contracts/${CONTRACT_ID}/submissions` && method === "POST") {
      if (state.nativeOnly) return jsonResponse({ error: "Deliver this contract as a package.", code: "native_delivery_required" }, 409);
      if (state.submissionError) return jsonResponse(state.submissionError, 409);
      return (
        state.submission ?? { submission: { id: "cmwsub7k2000f06l1abcdefgh", createdAt: "2026-10-22T10:00:00.000Z" }, replayed: false }
      );
    }
    const deliveries = `/agent/contracts/${CONTRACT_ID}/deliveries`;
    if (path === deliveries && method === "GET") return { deliveries: state.deliveries ?? [], nextCursor: null };
    if (path === deliveries && method === "POST") return { delivery: draftRow() };
    if (path === `${deliveries}/${PKG}/external-artifacts` && method === "POST") return { artifact: { id: "art-1" } };
    if (path === `${deliveries}/${PKG}` && method === "GET") {
      return {
        delivery: draftRow({
          version: 2,
          artifacts: [{ id: "art-1", kind: "external_url", externalUrl: "https://github.com/ama/verdikta-writeup", status: "external" }],
        }),
      };
    }
    if (path === `${deliveries}/${PKG}` && method === "PATCH") return { delivery: draftRow({ version: 3 }) };
    if (path === `${deliveries}/${PKG}/submit` && method === "POST")
      return { delivery: draftRow({ status: "submitted", revision: 1, version: 4 }) };
    if (path === `/agent/tasks/${COMP}/entries` && method === "GET")
      return { entries: state.entries ?? [], aggregate: {}, nextCursor: null };
    if (path === `/agent/tasks/${COMP}/entries` && method === "POST") {
      return {
        entry: { id: "cmwent7k2000g06l1abcdefgh", taskId: COMP, status: "active", currentVersionId: "v1" },
        version: {},
        replayed: false,
      };
    }
    if (path === "/agent/me") {
      return {
        profile: {
          id: "cmwsel7k2000e06l1abcdefgh",
          kind: "agent",
          handle: "ama-agent",
          displayName: "Ama",
          skillsTags: ["python"],
          publicProfileUrl: "/agents/ama-agent",
        },
        activePayoutMethodCount: 1,
        routerPayablePayoutMethodCount: 1,
        stats: { activeBids: 1, contractsAsSeller: 2, averageRating: 5, reviewCount: 1 },
      };
    }
    if (path === "/agent/me/payout-methods") {
      return {
        methods: [{ id: "pm1", symbol: "USDC", network: "base", address: "0x1234567890abcdef1234567890abcdef12345678", isActive: true }],
        nextCursor: null,
      };
    }
    return jsonResponse({ error: `unexpected ${method} ${path}` }, 500);
  });
}

const authed = (state: State = {}, calls: Call[] = []) => testContext({ fetch: router(state, calls), credentials: CREDS });
const posts = (calls: Call[]) => calls.filter((c) => ["POST", "PUT", "PATCH", "DELETE"].includes(c.init?.method ?? "GET"));
const bodyOf = (call: Call | undefined) => JSON.parse(String(call?.init?.body)) as Rec;

describeConnectorConformance(opentask, { search: { query: "python" }, fetch: router(), minResults: 3 });

describe("opentask search and get", () => {
  it("maps open tasks with their budget", async () => {
    const calls: Call[] = [];
    const { jobs, more } = await opentask.search!({ query: "python" }, testContext({ fetch: router({}, calls) }));
    expect(calls[0]!.url).toBe("https://opentask.ai/api/tasks?query=python&sort=new&limit=20");
    expect(more).toBe(false);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      id: "cmpupoqmm0027kw04351wcfhz",
      kind: "task",
      title: "Write a Python script to parse JSON and output CSV",
      org: "Skill Exec Agent",
      location: { remote: true },
      pay: { min: 50, max: 50, currency: "USDC", period: "unit", unit: "per task", text: "50 USDC" },
      url: "https://opentask.ai/tasks/cmpupoqmm0027kw04351wcfhz",
      posted_at: "2026-06-01T04:31:38.447Z",
    });
    expect(jobs[0]!.tags).toEqual(["python", "automation", "data-extraction", "pitch", "agent-allowed", "source:opentask"]);
    expect(jobs[0]!.stages).toBeUndefined();
    expect(jobs[0]!.apply_hint).toContain("answers.price");
  });

  it("matches every word when no task holds the whole phrase", async () => {
    const calls: Call[] = [];
    const { jobs } = await opentask.search!({ query: "audit docs" }, testContext({ fetch: router({}, calls) }));
    expect(calls.map((c) => new URL(c.url).searchParams.get("query"))).toEqual(["audit docs", "audit", "docs"]);
    expect(jobs.map((j) => j.id)).toEqual(["cmv11tua3007606jj2ne1mbwc"]);
  });

  it("pages the newest tasks, tags unpaid ones and answers nothing for listings", async () => {
    const calls: Call[] = [];
    const { jobs, more } = await opentask.search!({ limit: 3 }, testContext({ fetch: router({}, calls) }));
    expect(calls[0]!.url).toBe("https://opentask.ai/api/tasks?sort=new&limit=3");
    expect(jobs).toHaveLength(3);
    expect(more).toBe(true);
    expect(jobs[1]!.pay).toBeUndefined();
    const roadmap = taskToJob({
      id: "cmladr1120001jj04fb99ttm2",
      title: "Onboarding page",
      budgetText: "0 (internal roadmap item)",
      budgetAmount: null,
    });
    expect(roadmap).toMatchObject({ pay: { text: "0 (internal roadmap item)" } });
    expect(roadmap!.tags).toContain("unpaid");
    expect(taskToJob({ id: "x", title: "" })).toBeNull();
    expect((await opentask.search!({ query: "python", kind: "listing" }, testContext({ fetch: router() }))).jobs).toEqual([]);
  });

  it("reads a task with its criteria, deliverables and deadline", async () => {
    const job = await opentask.get!(TASK, testContext({ fetch: router() }));
    expect(job).toMatchObject({
      id: TASK,
      title: TASK_TITLE,
      org: "nigelon11",
      pay: { min: 30, currency: "USDC", unit: "per task" },
      expires_at: "2026-11-03T23:30:00.000Z",
      raw: { execution_mode: "pitch", delivery: "milestones", status: "open", updated_at: "2026-10-15T23:10:52.168Z" },
    });
    expect(job!.requirements?.rules).toHaveLength(5);
    expect(job!.description).toContain("Acceptance criteria:\n- A task posted on bounties.verdikta.org");
    expect(job!.description).toContain("Deliverables: Verdikta task URL; funding transaction hash");
    expect(job!.description).toContain("- Verdikta Bounties Agent Reference: https://bounties.verdikta.org/agents.txt");
    expect(job!.description).toContain("Delivered in milestones");
    expect(job!.summary!.length).toBeLessThanOrEqual(301);
    expect(job!.stages).toBeUndefined();
  });

  it("reads a competition as a prize and drops apply once intake closes", async () => {
    const job = await opentask.get!(COMP, testContext({ fetch: router() }));
    expect(job).toMatchObject({
      id: COMP,
      pay: { min: 20, max: 20, currency: "USDC", period: "unit", unit: "prize", text: "20 USDC prize, 1 winner" },
      stages: ["search", "get"],
      raw: { execution_mode: "bounty", phase: "reviewing_entries" },
    });
    expect(job!.tags).toContain("bounty");
    expect(job!.apply_hint).toContain("Competition");
  });

  it("answers not_found for unknown tasks and null for ids that cannot be OpenTask's", async () => {
    await expect(opentask.get!("cmzzzzzzzzzzzzzzzzzzzzzzz", testContext({ fetch: router() }))).rejects.toMatchObject({ code: "not_found" });
    expect(await opentask.get!("not an id", testContext({ fetch: router() }))).toBeNull();
  });
});

describe("opentask bids", () => {
  it("needs a token and a note", async () => {
    await expect(opentask.apply!(TASK, { note: "Hi" }, testContext({ fetch: router() }))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("https://opentask.ai/account/tokens"),
    });
    await expect(opentask.apply!(TASK, {}, authed())).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("note"),
    });
    await expect(opentask.apply!(TASK, { note: "Plan", answers: { eta_days: "soon" } }, authed())).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("eta_days"),
    });
  });

  it("bids with the task's updatedAt, the price and the approach", async () => {
    const calls: Call[] = [];
    const app = await opentask.apply!(
      TASK,
      { answers: { price: "25", eta_days: "5" }, note: "I post a funded rubric task, get it judged and publish the write-up." },
      authed({}, calls),
    );
    expect(calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
      `GET https://opentask.ai/api/tasks/${TASK}`,
      `GET https://opentask.ai/api/agent/bids?taskId=${TASK}&limit=20`,
      `POST https://opentask.ai/api/agent/tasks/${TASK}/bids`,
    ]);
    expect(header(calls[0]!.init, "authorization")).toBeUndefined();
    const post = calls[2]!;
    expect(header(post.init, "authorization")).toBe("Bearer ot_test");
    expect(header(post.init, "content-type")).toBe("application/json");
    expect(bodyOf(post)).toEqual({
      expectedTaskUpdatedAt: "2026-10-15T23:10:52.168Z",
      priceText: "25 USDC",
      etaDays: 5,
      approach: "I post a funded rubric task, get it judged and publish the write-up.",
    });
    expect(app).toMatchObject({
      id: BID_ID,
      job_id: TASK,
      job_title: TASK_TITLE,
      stage: "applied",
      url: `https://opentask.ai/tasks/${TASK}`,
      created_at: "2026-10-20T10:00:00.000Z",
    });
    expect(app.next).toContain("hire");
  });

  it("bids the task budget when no price is given", async () => {
    const calls: Call[] = [];
    await opentask.apply!(TASK, { note: "Plan" }, authed({}, calls));
    expect(bodyOf(posts(calls)[0])).toEqual({ expectedTaskUpdatedAt: "2026-10-15T23:10:52.168Z", priceText: "30 USDC", approach: "Plan" });
  });

  it("returns the existing bid instead of bidding twice", async () => {
    const calls: Call[] = [];
    const app = await opentask.apply!(TASK, { note: "Plan" }, authed({ mine: [bidRow()] }, calls));
    expect(posts(calls)).toEqual([]);
    expect(app).toMatchObject({ id: BID_ID, stage: "applied" });
  });

  it("bids again after a rejected, withdrawn or expired bid, or a cancelled contract", async () => {
    for (const status of ["rejected", "withdrawn", "expired"]) {
      const calls: Call[] = [];
      await opentask.apply!(TASK, { note: "Plan" }, authed({ mine: [bidRow({ status })] }, calls));
      expect(posts(calls).map((c) => new URL(c.url).pathname)).toEqual([`/api/agent/tasks/${TASK}/bids`]);
    }
    const cancelled = bidRow({ status: "accepted", contract: { id: CONTRACT_ID, status: "cancelled" } });
    const again: Call[] = [];
    await opentask.apply!(
      TASK,
      { note: "Plan" },
      authed({ mine: [cancelled], bid: cancelled, contract: contractRow({ status: "cancelled" }) }, again),
    );
    expect(posts(again).map((c) => new URL(c.url).pathname)).toEqual([`/api/agent/tasks/${TASK}/bids`]);
    const hired = bidRow({ status: "accepted", contract: { id: CONTRACT_ID, status: "in_progress" } });
    const kept: Call[] = [];
    const app = await opentask.apply!(
      TASK,
      { note: "Plan" },
      authed({ mine: [bidRow({ id: "cmwbid7k2000z06l1abcdefgh", status: "rejected" }), hired], bid: hired }, kept),
    );
    expect(posts(kept)).toEqual([]);
    expect(app).toMatchObject({ id: BID_ID, stage: "work_needed", raw: { contract_id: CONTRACT_ID } });
  });

  it("follows a bid into its contract", async () => {
    const hired = { bid: bidRow({ status: "accepted", contract: { id: CONTRACT_ID, status: "in_progress" } }) };
    expect(await opentask.status!(BID_ID, authed(hired))).toMatchObject({
      stage: "work_needed",
      url: `https://opentask.ai/dashboard/contracts/${CONTRACT_ID}`,
      updated_at: "2026-10-21T09:00:00.000Z",
      raw: { contract_id: CONTRACT_ID, contract_status: "in_progress" },
    });
    const paid = await opentask.status!(
      BID_ID,
      authed({ ...hired, contract: contractRow({ status: "accepted", settlementStatus: "fully_settled" }) }),
    );
    expect(paid).toMatchObject({ stage: "accepted", review: { earned: { amount: 30, currency: "USDC" } } });
    expect(await opentask.status!(BID_ID, authed())).toMatchObject({ stage: "applied" });
    const listed = await opentask.status!(BID_ID, authed({ bid: bidRow({ status: "accepted" }), contracts: [contractRow()] }));
    expect(listed).toMatchObject({ stage: "work_needed", raw: { contract_id: CONTRACT_ID } });
    expect(await opentask.status!("no such id!", authed())).toBeNull();
    expect(bidToApplication(bidRow({ status: "withdrawn" })).stage).toBe("withdrawn");
    expect(bidToApplication(bidRow({ status: "expired" })).stage).toBe("closed");
    expect(bidToApplication(bidRow({ status: "accepted" }), contractRow({ status: "submitted" })).stage).toBe("in_review");
    expect(bidToApplication(bidRow({ status: "accepted" }), contractRow({ status: "cancelled" })).stage).toBe("closed");
  });

  it("lists bids with their contracts and won entries", async () => {
    const contracts = [
      contractRow({ status: "accepted", settlementStatus: "fully_settled" }),
      contractRow({
        id: "cmwctr7k2000h06l1abcdefgh",
        source: "task_award",
        status: "accepted",
        settlementStatus: "fully_settled",
        task: { id: COMP, title: "Make OpenTask Impossible to Scroll Past — 20 USDC" },
        bid: null,
        taskAward: { id: "aw1", sellerAmountAtomic: "20000000", payoutToken: "USDC", payoutTokenDecimals: 6, payoutNetwork: "BASE" },
      }),
    ];
    const mine = await opentask.list!(
      authed({ mine: [bidRow({ status: "accepted" }), bidRow({ id: "cmwbid7k2000i06l1abcdefgh" })], contracts }),
    );
    expect(mine.map((a) => [a.id, a.stage])).toEqual([
      [BID_ID, "accepted"],
      ["cmwbid7k2000i06l1abcdefgh", "applied"],
      [`${COMP}/entry`, "accepted"],
    ]);
    expect(mine[2]).toMatchObject({ review: { earned: { amount: 20, currency: "USDC" } } });
  });
});

describe("opentask delivery", () => {
  const hired: State = { bid: bidRow({ status: "accepted", contract: { id: CONTRACT_ID, status: "in_progress" } }) };
  const file = { kind: "file" as const, name: "report.md", mime_type: "text/markdown", bytes: new TextEncoder().encode("# Report\n") };

  it("uploads a file through an upload intent and lists it", async () => {
    const calls: Call[] = [];
    const receipt = await opentask.upload!(BID_ID, file, authed({ ...hired, intents: [intentRow({ fileStatus: "processing" })] }, calls));
    const writes = posts(calls);
    expect(writes.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `POST https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/submission-attachments/upload-intents`,
      `PUT ${UPLOAD_URL}`,
      `POST https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/submission-attachments/upload-intents/${INTENT_ID}/complete`,
    ]);
    expect(bodyOf(writes[0])).toEqual({
      filename: "report.md",
      contentType: "text/markdown",
      sizeBytes: 9,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
    expect(header(writes[0]!.init, "idempotency-key")).toMatch(/^wp-[0-9a-f]{40}$/u);
    expect(writes[1]!.init?.headers).toEqual({ "content-type": "text/markdown" });
    expect(new TextDecoder().decode(writes[1]!.init?.body as Uint8Array)).toBe("# Report\n");
    expect(writes[2]!.init?.body).toBeUndefined();
    expect(receipt).toMatchObject({
      file: { id: INTENT_ID, name: "report.md", kind: "text/markdown", size: 9 },
      files: [{ id: INTENT_ID }],
    });
  });

  it("refuses uploads before the hire and duplicates", async () => {
    await expect(opentask.upload!(BID_ID, file, authed())).rejects.toMatchObject({ code: "wrong_stage" });
    const replay = { uploadIntent: intentRow(), limits: {}, pollAfterMs: null, replayed: true };
    await expect(opentask.upload!(BID_ID, file, authed({ ...hired, created: replay }))).rejects.toMatchObject({
      code: "already_exists",
      details: { file: { id: INTENT_ID, name: "report.md" } },
    });
  });

  it("removes an upload", async () => {
    const calls: Call[] = [];
    const receipt = await opentask.remove!(BID_ID, INTENT_ID, authed({ ...hired, intents: [intentRow()] }, calls));
    expect(posts(calls).map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `DELETE https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/submission-attachments/upload-intents/${INTENT_ID}`,
    ]);
    expect(receipt).toMatchObject({ removed: { id: INTENT_ID, name: "report.md" }, files: [] });
  });

  it("submits the ready files and the link in the note", async () => {
    const calls: Call[] = [];
    const note = "Done: https://github.com/ama/verdikta-writeup. Funding tx in the README.";
    const app = await opentask.submit!(BID_ID, { note }, authed({ ...hired, intents: [intentRow()] }, calls));
    const post = posts(calls)[0]!;
    expect(post.url).toBe(`https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/submissions`);
    expect(header(post.init, "idempotency-key")).toMatch(/^wp-[0-9a-f]{40}$/u);
    expect(header(post.init, "authorization")).toBe("Bearer ot_test");
    expect(bodyOf(post)).toEqual({ deliverableUrl: "https://github.com/ama/verdikta-writeup", fileIds: [FILE_ID], notes: note });
    expect(app).toMatchObject({
      id: BID_ID,
      stage: "in_review",
      files: [{ id: INTENT_ID }],
      raw: { submission_id: "cmwsub7k2000f06l1abcdefgh" },
    });
  });

  it("waits for scanned files, needs a deliverable and does not submit twice", async () => {
    await expect(
      opentask.submit!(BID_ID, { note: "Done" }, authed({ ...hired, intents: [intentRow({ fileStatus: "processing" })] })),
    ).rejects.toMatchObject({
      code: "not_ready",
    });
    await expect(opentask.submit!(BID_ID, { note: "Done" }, authed(hired))).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("link"),
    });
    await expect(opentask.submit!(BID_ID, { note: "Done" }, authed())).rejects.toMatchObject({ code: "wrong_stage" });
    const calls: Call[] = [];
    const again = await opentask.submit!(
      BID_ID,
      { note: "Done" },
      authed({ ...hired, contract: contractRow({ status: "submitted" }) }, calls),
    );
    expect(posts(calls)).toEqual([]);
    expect(again.stage).toBe("in_review");
  });

  it("resubmits a rejected contract under a new key and does not count a replay as a new submission", async () => {
    const note = "Fixed: https://github.com/ama/verdikta-writeup";
    const keyFor = async (contract: Rec) => {
      const calls: Call[] = [];
      await opentask.submit!(BID_ID, { note }, authed({ ...hired, contract }, calls));
      return header(posts(calls)[0]!.init, "idempotency-key");
    };
    const first = await keyFor(contractRow({ _count: { submissions: 0 } }));
    expect(await keyFor(contractRow({ _count: { submissions: 0 } }))).toBe(first);
    const rejected = contractRow({ status: "rejected", updatedAt: "2026-10-23T09:00:00.000Z", _count: { submissions: 1 } });
    expect(await keyFor(rejected)).not.toBe(first);
    const replay = { submission: { id: "cmwsub7k2000f06l1abcdefgh" }, replayed: true };
    await expect(opentask.submit!(BID_ID, { note }, authed({ ...hired, contract: rejected, submission: replay }))).rejects.toMatchObject({
      code: "already_exists",
      details: { stage: "rejected", submission_id: "cmwsub7k2000f06l1abcdefgh" },
    });
  });

  it("keeps OpenTask's error code and moves to native delivery only on native_delivery_required", async () => {
    const note = "Done: https://github.com/ama/verdikta-writeup";
    const calls: Call[] = [];
    const disabled = { error: "Native deliveries are temporarily disabled.", code: "native_deliveries_disabled" };
    await expect(opentask.submit!(BID_ID, { note }, authed({ ...hired, submissionError: disabled }, calls))).rejects.toMatchObject({
      code: "invalid_input",
      details: { status: 409, code: "native_deliveries_disabled" },
    });
    expect(posts(calls).map((c) => new URL(c.url).pathname)).toEqual([`/api/agent/contracts/${CONTRACT_ID}/submissions`]);
  });

  it("follows the contract's suggested submit_deliverable over the native delivery flag", async () => {
    const note = "Done: https://github.com/ama/verdikta-writeup";
    const flagged = contractRow({ nativeDeliveryAvailability: { enabled: true } });
    const toNative: Call[] = [];
    await opentask.submit!(BID_ID, { note }, authed({ ...hired, contract: flagged }, toNative));
    expect(new URL(posts(toNative)[0]!.url).pathname).toBe(`/api/agent/contracts/${CONTRACT_ID}/deliveries`);
    const ordinary: Call[] = [];
    await opentask.submit!(
      BID_ID,
      { note },
      authed({ ...hired, contract: { ...flagged, suggestedAction: "submit_deliverable" } }, ordinary),
    );
    expect(new URL(posts(ordinary)[0]!.url).pathname).toBe(`/api/agent/contracts/${CONTRACT_ID}/submissions`);
  });

  it("keeps notes, file counts and links within OpenTask's limits", async () => {
    const long = `Done: https://github.com/ama/verdikta-writeup ${"word ".repeat(5000)}`;
    const ordinary: Call[] = [];
    await opentask.submit!(BID_ID, { note: long }, authed(hired, ordinary));
    expect(String(bodyOf(posts(ordinary)[0]).notes).length).toBeLessThanOrEqual(20000);
    const schedule = {
      contractId: CONTRACT_ID,
      contractStatus: "in_progress",
      summary: { settlementMode: "milestones" },
      milestones: [{ id: "ms-0001", sequence: 1, title: "Post and fund the task", status: "active", version: 3 }],
    };
    const milestone: Call[] = [];
    await opentask.submit!(BID_ID, { note: long }, authed({ ...hired, milestones: schedule }, milestone));
    expect(String(bodyOf(posts(milestone)[0]).notes).length).toBeLessThanOrEqual(5000);
    const bid: Call[] = [];
    await opentask.apply!(TASK, { note: "x".repeat(12000) }, authed({}, bid));
    expect(String(bodyOf(posts(bid)[0]).approach).length).toBeLessThanOrEqual(10000);
    const many = Array.from({ length: 21 }, (_, i) =>
      intentRow({ id: `cmwupl7k2000c06l1q8w2${String(i).padStart(4, "0")}`, fileId: `f${i}` }),
    );
    await expect(opentask.submit!(BID_ID, { note: "Done" }, authed({ ...hired, intents: many }))).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("at most 20 files"),
    });
    await expect(opentask.submit!(BID_ID, { note: `https://example.com/${"a".repeat(2000)}` }, authed(hired))).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("2000"),
    });
  });

  it("submits the open milestone of a milestone contract", async () => {
    const calls: Call[] = [];
    const milestones = {
      contractId: CONTRACT_ID,
      contractStatus: "in_progress",
      summary: { settlementMode: "milestones", scheduleState: "locked" },
      milestones: [
        {
          id: "ms-0002",
          sequence: 2,
          title: "Write-up",
          status: "proposed",
          version: 1,
          recommendedAction: "await_buyer_milestone_activation",
        },
        {
          id: "ms-0001",
          sequence: 1,
          title: "Post and fund the task",
          status: "active",
          version: 3,
          recommendedAction: "submit_milestone",
        },
      ],
    };
    const note = "Task posted: https://bounties.verdikta.org/task/42";
    const app = await opentask.submit!(BID_ID, { note }, authed({ ...hired, milestones }, calls));
    const post = posts(calls)[0]!;
    expect(post.url).toBe(`https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/milestones/ms-0001/submit`);
    expect(header(post.init, "idempotency-key")).toMatch(/^wp-[0-9a-f]{40}$/u);
    expect(bodyOf(post)).toEqual({ expectedVersion: 3, deliverableUrl: "https://bounties.verdikta.org/task/42", notes: note });
    expect(app).toMatchObject({ stage: "in_review", raw: { milestone_id: "ms-0001" } });
    expect(app.next).toContain("Milestone 1");
    await expect(opentask.upload!(BID_ID, file, authed({ ...hired, milestones }))).rejects.toMatchObject({ code: "not_supported" });
    const sent = { ...milestones, milestones: [{ ...milestones.milestones[1]!, status: "submitted" }, milestones.milestones[0]!] };
    expect(await opentask.submit!(BID_ID, { note }, authed({ ...hired, milestones: sent }))).toMatchObject({ stage: "in_review" });
  });

  const native: State = { ...hired, contractActions: [{ action: "prepare_delivery", label: "Prepare delivery", state: "available" }] };

  it("uploads into a new native delivery draft", async () => {
    const calls: Call[] = [];
    await opentask.upload!(BID_ID, file, authed(native, calls));
    const writes = posts(calls);
    expect(writes.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `POST https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/deliveries`,
      `POST https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}/upload-intents`,
      `PUT ${UPLOAD_URL}`,
      `POST https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}/upload-intents/${INTENT_ID}/complete`,
    ]);
    expect(bodyOf(writes[0])).toEqual({ title: TASK_TITLE });
    expect(header(writes[0]!.init, "idempotency-key")).toMatch(/^wp-[0-9a-f]{40}$/u);
  });

  it("delivers a native package: the link as an artifact, every criterion claimed, the files bound", async () => {
    const calls: Call[] = [];
    const note = "Done: https://github.com/ama/verdikta-writeup\n\nThe funding transaction and wallet are in the README.";
    const state = { ...native, deliveries: [draftRow()], intents: [intentRow({ purpose: "delivery_artifact" })] };
    const app = await opentask.submit!(BID_ID, { note }, authed(state, calls));
    const writes = posts(calls);
    expect(writes.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `POST https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}/external-artifacts`,
      `PATCH https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}`,
      `POST https://opentask.ai/api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}/submit`,
    ]);
    for (const write of writes) {
      expect(header(write.init, "idempotency-key")).toMatch(/^wp-[0-9a-f]{40}$/u);
      expect(header(write.init, "authorization")).toBe("Bearer ot_test");
    }
    expect(bodyOf(writes[0])).toEqual({
      expectedVersion: 1,
      kind: "external_url",
      label: "Deliverable",
      url: "https://github.com/ama/verdikta-writeup",
    });
    expect(bodyOf(writes[1])).toEqual({
      expectedVersion: 2,
      summary: "Done: https://github.com/ama/verdikta-writeup",
      verificationInstructions: note,
      criteria: [
        { criterionId: "crit-1", claim: "satisfied", artifactIds: ["art-1"] },
        { criterionId: "crit-2", claim: "satisfied", artifactIds: ["art-1"] },
      ],
    });
    expect(bodyOf(writes[2])).toEqual({
      expectedVersion: 3,
      nativeArtifacts: [{ fileId: FILE_ID, label: "report.md", criterionIds: ["crit-1", "crit-2"] }],
      confirmed: true,
    });
    expect(app).toMatchObject({
      stage: "in_review",
      files: [{ id: INTENT_ID }],
      raw: { delivery_id: PKG, revision: 1, delivery_status: "submitted" },
    });
  });

  it("revises on the package the poster sent back", async () => {
    const reviewed = draftRow({ id: "cmwpkg7k2000m06l1abcdefgh", status: "changes_requested", revision: 1 });
    const note = "Fixed the word count: https://github.com/ama/verdikta-writeup";
    const rebased: Call[] = [];
    await opentask.submit!(BID_ID, { note }, authed({ ...native, deliveries: [draftRow(), reviewed] }, rebased));
    const patch = posts(rebased).find((c) => c.init?.method === "PATCH");
    expect(bodyOf(patch)).toMatchObject({ expectedVersion: 2, basedOnDeliveryPackageId: "cmwpkg7k2000m06l1abcdefgh", changeSummary: note });
    const created: Call[] = [];
    await opentask.submit!(BID_ID, { note }, authed({ ...native, deliveries: [reviewed] }, created));
    expect(bodyOf(posts(created)[0])).toEqual({ title: TASK_TITLE, basedOnDeliveryPackageId: "cmwpkg7k2000m06l1abcdefgh" });
  });

  it("reports a package under review and moves to native delivery when the contract asks for it", async () => {
    const calls: Call[] = [];
    const pending = await opentask.submit!(
      BID_ID,
      { note: "Done" },
      authed({ ...native, deliveries: [draftRow({ status: "submitted" })] }, calls),
    );
    expect(posts(calls)).toEqual([]);
    expect(pending).toMatchObject({ stage: "in_review", raw: { delivery_id: PKG, delivery_status: "submitted" } });
    const moved: Call[] = [];
    const app = await opentask.submit!(
      BID_ID,
      { note: "Done: https://github.com/ama/verdikta-writeup" },
      authed({ ...hired, nativeOnly: true }, moved),
    );
    expect(posts(moved).map((c) => `${c.init?.method} ${new URL(c.url).pathname}`)).toEqual([
      `POST /api/agent/contracts/${CONTRACT_ID}/submissions`,
      `POST /api/agent/contracts/${CONTRACT_ID}/deliveries`,
      `POST /api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}/external-artifacts`,
      `PATCH /api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}`,
      `POST /api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}/submit`,
    ]);
    expect(app).toMatchObject({ stage: "in_review", raw: { delivery_id: PKG } });
  });

  it("does not add a link the draft already holds", async () => {
    const calls: Call[] = [];
    const held = draftRow({
      version: 2,
      artifacts: [{ id: "art-1", kind: "external_url", externalUrl: "https://GitHub.com/ama/verdikta-writeup", status: "external" }],
    });
    await opentask.submit!(
      BID_ID,
      { note: "Done: https://github.com/ama/verdikta-writeup" },
      authed({ ...native, deliveries: [held] }, calls),
    );
    const writes = posts(calls);
    expect(writes.map((c) => `${c.init?.method} ${new URL(c.url).pathname}`)).toEqual([
      `PATCH /api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}`,
      `POST /api/agent/contracts/${CONTRACT_ID}/deliveries/${PKG}/submit`,
    ]);
    expect(bodyOf(writes[0])).toMatchObject({
      expectedVersion: 2,
      criteria: [
        { criterionId: "crit-1", claim: "satisfied", artifactIds: ["art-1"] },
        { criterionId: "crit-2", claim: "satisfied", artifactIds: ["art-1"] },
      ],
    });
  });

  it("takes only https links into a delivery package", async () => {
    const calls: Call[] = [];
    await expect(
      opentask.submit!(BID_ID, { note: "Done: http://example.com/writeup" }, authed({ ...native, deliveries: [draftRow()] }, calls)),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("https://") });
    expect(posts(calls)).toEqual([]);
    const later: Call[] = [];
    const note = "Notes at http://example.com/notes; the work: https://github.com/ama/verdikta-writeup";
    await opentask.submit!(BID_ID, { note }, authed({ ...native, deliveries: [draftRow()] }, later));
    expect(bodyOf(posts(later)[0])).toMatchObject({ url: "https://github.com/ama/verdikta-writeup" });
  });

  it("names the parent in the upload key and keeps file labels within 200 characters", async () => {
    const keyOf = (calls: Call[]) => header(posts(calls).find((c) => c.url.endsWith("/upload-intents"))!.init, "idempotency-key");
    const ordinary: Call[] = [];
    await opentask.upload!(BID_ID, file, authed(hired, ordinary));
    const draft: Call[] = [];
    await opentask.upload!(BID_ID, file, authed({ ...native, deliveries: [draftRow()] }, draft));
    expect(keyOf(draft)).toMatch(/^wp-[0-9a-f]{40}$/u);
    expect(keyOf(draft)).not.toBe(keyOf(ordinary));
    const calls: Call[] = [];
    const named = intentRow({ purpose: "delivery_artifact", filename: `${"r".repeat(300)}.md` });
    await opentask.submit!(
      BID_ID,
      { note: "Done: https://github.com/ama/verdikta-writeup" },
      authed({ ...native, deliveries: [draftRow()], intents: [named] }, calls),
    );
    const submit = bodyOf(posts(calls).find((c) => c.url.endsWith("/submit")));
    expect(String((submit.nativeArtifacts as Rec[])[0]!.label).length).toBeLessThanOrEqual(200);
  });
});

describe("opentask competitions", () => {
  const open: Rec = {
    ...COMPETITION,
    availableActions: [{ action: "submit_task_entry", label: "Submit an entry", state: "available", actor: { role: "worker" } }],
  };

  it("opens an entry without sending anything, and not after intake closes", async () => {
    const calls: Call[] = [];
    const app = await opentask.apply!(COMP, {}, authed({ competition: open }, calls));
    expect(posts(calls)).toEqual([]);
    expect(app).toMatchObject({
      id: `${COMP}/entry`,
      job_id: COMP,
      stage: "work_needed",
      job_title: "Make OpenTask Impossible to Scroll Past — 20 USDC",
    });
    await expect(opentask.apply!(COMP, {}, authed())).rejects.toMatchObject({
      code: "wrong_stage",
      message: expect.stringContaining("Submissions are closed"),
    });
  });

  it("submits the uploaded artifacts as the first entry version", async () => {
    const calls: Call[] = [];
    const image = intentRow({ purpose: "task_entry_artifact", filename: "hook.png", contentType: "image/png" });
    const note = "A 14-second vertical video: an agent finds a paid task in two taps.";
    const app = await opentask.submit!(`${COMP}/entry`, { note }, authed({ competition: open, intents: [image] }, calls));
    const post = posts(calls)[0]!;
    expect(post.url).toBe(`https://opentask.ai/api/agent/tasks/${COMP}/entries`);
    expect(header(post.init, "idempotency-key")).toMatch(/^wp-[0-9a-f]{40}$/u);
    expect(bodyOf(post)).toEqual({
      expectedTaskUpdatedAt: "2026-08-15T16:32:14.124Z",
      artifacts: [{ kind: "native_file", fileId: FILE_ID, altText: note }],
      notes: note,
    });
    expect(app).toMatchObject({ id: `${COMP}/entry`, stage: "in_review", raw: { entry_id: "cmwent7k2000g06l1abcdefgh" } });
    await expect(opentask.submit!(`${COMP}/entry`, {}, authed({ intents: [image] }))).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("alt text"),
    });
    await expect(opentask.submit!(`${COMP}/entry`, { note }, authed())).rejects.toMatchObject({ code: "not_ready" });
  });

  it("keeps an image's alt text within 240 characters", async () => {
    const calls: Call[] = [];
    const image = intentRow({ purpose: "task_entry_artifact", filename: "hook.png", contentType: "image/png" });
    const note = `https://example.com/${"a".repeat(400)}`;
    await opentask.submit!(`${COMP}/entry`, { note }, authed({ competition: open, intents: [image] }, calls));
    const body = bodyOf(posts(calls)[0]);
    expect(String((body.artifacts as Rec[])[0]!.altText).length).toBeLessThanOrEqual(240);
    expect(body.notes).toBe(note);
  });

  it("follows the entry", async () => {
    expect(await opentask.status!(`${COMP}/entry`, authed())).toMatchObject({ stage: "work_needed" });
    expect(await opentask.status!(`${COMP}/entry`, authed({ entries: [{ id: "e1", status: "awarded" }] }))).toMatchObject({
      stage: "accepted",
      raw: { entry_id: "e1" },
    });
    expect(entryToApplication(COMP, { status: "not_selected" }).stage).toBe("rejected");
    expect(entryToApplication(COMP, { status: "changes_requested" }).stage).toBe("work_needed");
  });
});

describe("opentask account and earnings", () => {
  it("reads the profile", async () => {
    expect(await opentask.account!(authed())).toMatchObject({
      signed_in: true,
      label: "ama-agent",
      ready: true,
      profile: { handle: "ama-agent", public_profile: "https://opentask.ai/agents/ama-agent", payout_wallets: 1 },
    });
    expect(await opentask.account!(testContext({ fetch: router() }))).toMatchObject({ signed_in: false });
  });

  it("sums paid and pending contracts and names the payout wallets", async () => {
    const contracts = [
      contractRow({ status: "accepted", settlementStatus: "fully_settled" }),
      contractRow({
        id: "cmwctr7k2000j06l1abcdefgh",
        status: "accepted",
        settlementStatus: "partially_settled",
        bid: { id: "b2", priceText: "12.5 USDC" },
      }),
      contractRow({ id: "cmwctr7k2000k06l1abcdefgh", status: "in_progress" }),
    ];
    const earnings = await opentask.earnings!(authed({ contracts }));
    expect(earnings).toMatchObject({
      balance: { amount: 0, currency: "USDC" },
      total_earned: { amount: 30, currency: "USDC" },
      pending: { amount: 12.5, currency: "USDC" },
      methods: ["USDC on base 0x1234…5678"],
    });
    expect(earnings.entries).toEqual([
      {
        id: CONTRACT_ID,
        application_id: BID_ID,
        job_title: TASK_TITLE,
        amount: 30,
        currency: "USDC",
        status: "paid",
        earned_at: "2026-10-21T09:00:00.000Z",
      },
      {
        id: "cmwctr7k2000j06l1abcdefgh",
        application_id: "b2",
        job_title: TASK_TITLE,
        amount: 12.5,
        currency: "USDC",
        status: "pending",
        earned_at: "2026-10-21T09:00:00.000Z",
      },
    ]);
    await expect(opentask.earnings!(testContext({ fetch: router() }))).rejects.toMatchObject({ code: "auth_required" });
  });
});

describe("opentask helpers", () => {
  it("reads prices and links", () => {
    expect(moneyOf("30 USDC")).toEqual({ amount: 30, currency: "USDC" });
    expect(moneyOf("Get paid $15 for a clip")).toEqual({ amount: 15, currency: "USD" });
    expect(moneyOf("Free - community contribution")).toBeUndefined();
    expect(firstLink("See https://example.com/a.pdf, then reply.")).toBe("https://example.com/a.pdf");
    expect(firstLink("See http://example.com/a and https://example.com/b.", true)).toBe("https://example.com/b");
    expect(firstLink("no link")).toBeUndefined();
  });
});
