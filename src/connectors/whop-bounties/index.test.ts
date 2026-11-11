import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, jsonResponse, testContext } from "../../core/conformance.js";
import { ProtocolError } from "../../core/errors.js";
import {
  bountyToJob,
  countryCode,
  createWhopBounties,
  isPaidEngagement,
  payoutToNative,
  submissionToApplication,
  WHOP_API_VERSION,
  whopBounties,
} from "./index.js";

type Rec = Record<string, unknown>;
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Rec;

// The fixtures follow the Whop API reference's example objects: listing bounties and every write need a signed-in user.
const SEARCH = read("search");
const ROWS = SEARCH.data as Rec[];
const BOUNTY = read("bounty");
const SUBMISSION = read("submission");
const USER = read("user");
const PAYOUTS = read("payouts");
const METHODS = read("payout-methods");
const FILE = read("file");
// A bounty read by id carries capture_spec (list rows do not); the spec's values follow the Bounty reference's examples.
const CAPTURE_SPEC: Rec = {
  filename_pattern: "Country_City_Site_Station_Operator",
  manifest_schema_version: 2,
  min_clip_duration_seconds: 120,
  min_total_verified_duration_seconds: 7200,
  single_continuous_take: true,
  required_metadata_fields: ["country", "city", "site", "station", "operator"],
  video: { fps: 30, height: 1080, min_fov_degrees: 130, preferred_fov_degrees: 140, orientation: "landscapeRight" },
  imu: { target_rate_hz: 100, min_rate_hz: 90 },
};
const DETAILS: Rec[] = [BOUNTY, { ...ROWS[1]!, capture_spec: null }, { ...ROWS[2]!, capture_spec: CAPTURE_SPEC }];
const CAPTURE_ANSWERS = { city: "Austin", country: "US", device: "iPhone 15 Pro", operator: "mwebb", site: "BurnetRd", station: "Bay2" };
const TOKEN = "whop_test_token";
const CREDS = { WHOP_OAUTH_TOKEN: TOKEN };
const OTHER_WORKER: Rec = { ...SUBMISSION, id: "btys_otherworker0001", worker: { id: "user_someoneelse0001", username: "someone" } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Override = (url: URL, method: string, headers: Record<string, string>, body: unknown) => unknown;

/** A fake Whop API: bounties by id answer anonymously, everything else wants the test token. */
function api(calls: Call[] = [], state: { submissions?: Rec[]; override?: Override } = {}) {
  const submissions: Rec[] = state.submissions ?? [SUBMISSION, OTHER_WORKER];
  return fixtureFetch((raw, init) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
    calls.push({ url: raw, method, headers, body });
    const url = new URL(raw);
    const custom = state.override?.(url, method, headers, body);
    if (custom !== undefined) return custom;
    if (url.hostname === "whop-uploads-example.s3.amazonaws.com") return new Response(null, { status: 200 });
    const route = url.pathname.replace(/^\/api\/v1/u, "");
    const bountyMatch = /^\/bounties\/(bnty_[A-Za-z0-9]+)$/u.exec(route);
    if (method === "GET" && bountyMatch) {
      const row = DETAILS.find((b) => b.id === bountyMatch[1]);
      return row ?? jsonResponse({ error: { type: "not_found", message: "Bounty not found" } }, 404);
    }
    if (headers.authorization !== `Bearer ${TOKEN}`)
      return jsonResponse({ error: { type: "unauthorized", message: "Authentication failed" } }, 401);
    if (route === "/users/me") return USER;
    if (route === "/bounties") return url.searchParams.get("user_id") ? { data: [BOUNTY], page_info: SEARCH.page_info } : SEARCH;
    if (route === "/bounty_submissions" && method === "GET") {
      const bountyId = url.searchParams.get("bounty_id");
      const status = url.searchParams.get("status");
      const data = submissions.filter((s) => (!bountyId || s.bounty_id === bountyId) && (!status || s.status === status));
      return { data, page_info: { end_cursor: null, start_cursor: null, has_next_page: false, has_previous_page: false } };
    }
    if (route === "/bounty_submissions" && method === "POST") {
      const sent = body as Rec;
      const capture = sent.deliverable === undefined;
      return jsonResponse(
        {
          ...SUBMISSION,
          id: capture ? "btys_capture00000001" : "btys_new000000000001",
          bounty_id: sent.bounty_id,
          status: capture ? "in_progress" : "submitted",
          deliverable_type: capture ? "data_capture" : "content_url",
          deliverable_urls: (sent.deliverable as Rec | undefined)?.urls ?? null,
          files: [],
          submitted_at: capture ? null : "2026-10-20T15:00:00.000Z",
          resolved_at: null,
        },
        201,
      );
    }
    const attempt = /^\/bounty_submissions\/(btys_[A-Za-z0-9]+)(\/submit)?$/u.exec(route);
    if (attempt) {
      const found = submissions.find((s) => s.id === attempt[1]);
      if (!found) return jsonResponse({ error: { type: "not_found", message: "Bounty submission not found" } }, 404);
      return attempt[2] && method === "POST" ? { ...found, status: "submitted", submitted_at: "2026-10-20T15:00:00.000Z" } : found;
    }
    if (route === "/files" && method === "POST") return jsonResponse(FILE, 201);
    if (route === "/payouts" && method === "GET") return PAYOUTS;
    if (route === "/payouts/methods") return METHODS;
    if (route === "/payouts" && method === "POST") {
      const sent = body as Rec;
      return jsonResponse(
        {
          ...(PAYOUTS.data as Rec[])[0],
          id: "wdrl_new0000000001",
          amount: String(sent.amount),
          status: "requested",
          payout_method: {
            nickname: null,
            supported_payout_method: {
              delivery_type: "unknown",
              icon_url: "https://cdn.whop.com/payouts/paypal.png",
              payer_name: "PayPal",
            },
          },
          notes: sent.notes ?? null,
        },
        201,
      );
    }
    return jsonResponse({ error: { type: "server_error", message: "unexpected" } }, 500);
  });
}

const tmpFiles: string[] = [];
function fresh() {
  const file = path.join(os.tmpdir(), `whop-bounties-test-${process.pid}-${tmpFiles.length}-${Date.now()}.json`);
  tmpFiles.push(file);
  return createWhopBounties({ draftsFile: file });
}
afterAll(() => {
  for (const file of tmpFiles) rmSync(file, { force: true });
});

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describeConnectorConformance(whopBounties, { search: { query: "clip" }, fetch: api(), credentials: CREDS, expectQueryInUrl: false });

describe("whop-bounties mapping", () => {
  it("maps a clipping bounty: net reward per accepted submission, countries, host page", () => {
    const job = bountyToJob(ROWS[0]!)!;
    expect(job).toMatchObject({
      id: "bnty_xxxxxxxxxxxx01",
      kind: "task",
      title: "Clip our Tuesday livestream",
      org: "Acme Studio",
      location: { text: "Open to residents of United States, Mexico", remote: true },
      pay: {
        min: 17.5,
        max: 17.5,
        currency: "USD",
        period: "unit",
        unit: "per accepted submission",
        text: "17.5 USD per accepted submission after fees (25 USD gross)",
      },
      url: "https://whop.com/acme-studio",
      posted_at: "2026-07-01T00:00:00.000Z",
      tags: ["clipping", "links", "files", "3 of 5 spots left", "source:whop-bounties"],
    });
    expect(job.stages).toBeUndefined();
    expect(job.requirements?.rules).toContain("Up to 2 winning submissions per person, one attempt at a time");
    expect(job.raw).toMatchObject({
      gross_reward_amount: 25,
      net_reward_amount: 17.5,
      spots_remaining: 3,
      viewer_accepted_submissions_count: 1,
    });
  });

  it("maps worldwide UGC, data capture and closed bounties", () => {
    const ugc = bountyToJob(ROWS[1]!)!;
    expect(ugc.location).toEqual({ text: "Worldwide", remote: true });
    expect(ugc.summary).toBe(
      "Shoot a 20-40 second vertical video of a ceramic coating reveal and post it to TikTok or Instagram Reels.\nTag the shop in the caption.",
    );
    expect(ugc.tags?.[0]).toBe("ugc");
    expect(ugc.apply_hint).toContain("No claim step");

    const capture = bountyToJob(ROWS[2]!)!;
    expect(capture.pay?.unit).toBe("per accepted submission of 2 h verified footage");
    expect(capture.location).toMatchObject({ country: "US", text: "Open to residents of United States" });
    expect(capture.tags).toEqual(["data-capture", "9 of 10 spots left", "source:whop-bounties"]);
    expect(capture.url).toBeUndefined();
    expect(capture.apply_hint).toContain("Whop app");

    expect(bountyToJob({ ...ROWS[0]!, status: "closed" })!.stages).toEqual(["search", "get"]);
    expect(bountyToJob({ id: "123", title: "x" })).toBeNull();
  });

  it("maps a reviewed submission with its bounty", () => {
    const app = submissionToApplication(SUBMISSION, BOUNTY);
    expect(app).toMatchObject({
      id: "btys_xxxxxxxxxxxxxx",
      job_id: "bnty_xxxxxxxxxxxx01",
      job_title: "Clip our Tuesday livestream",
      stage: "accepted",
      review: { earned: { amount: 17.5, currency: "USD" } },
      files: [
        { id: "https://www.tiktok.com/@shinetime/video/7412345678901234567", kind: "link" },
        { id: "file_xxxxxxxxxxxxxx", name: "stream-moment.png", kind: "image/png" },
      ],
    });
    expect(app.next).toContain("17.5 USD");
    expect(submissionToApplication({ ...SUBMISSION, status: "denied", denial_reason: "The clip never shows the stream." }).stage).toBe(
      "rejected",
    );
    expect(submissionToApplication({ ...SUBMISSION, status: null }).stage).toBe("closed");
  });

  it("labels a payout by its nickname, else the rail's display name", () => {
    const row = (PAYOUTS.data as Rec[])[0]!;
    expect(payoutToNative(row).method).toBe("Operating account");
    expect(payoutToNative({ ...row, payout_method: { ...(row.payout_method as Rec), nickname: null } }).method).toBe("ACH Bank Deposit");
  });

  it("reads country names and codes", () => {
    expect(countryCode("Accra, Ghana")).toBe("GH");
    expect(countryCode("us")).toBe("US");
    expect(countryCode("UK")).toBe("GB");
    expect(countryCode("Remote")).toBeUndefined();
  });
});

describe("whop-bounties find", () => {
  it("searches open bounties with the token and matches the words here", async () => {
    const calls: Call[] = [];
    const { jobs, more } = await whopBounties.search!(
      { query: "ceramic coating", location: "Accra, Ghana", limit: 5 },
      testContext({ fetch: api(calls), credentials: CREDS }),
    );
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.whop.com/api/v1/bounties");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("country")).toBe("GH");
    expect(url.searchParams.get("first")).toBe("100");
    expect(calls[0]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "api-version-date": WHOP_API_VERSION });
    expect(jobs.map((j) => j.id)).toEqual(["bnty_xxxxxxxxxxxx02"]);
    expect(more).toBe(true);
  });

  it("asks for a full page (some are filtered out here) and passes a bounty id to the API", async () => {
    const calls: Call[] = [];
    const ctx = testContext({ fetch: api(calls), credentials: CREDS });
    const all = await whopBounties.search!({}, ctx);
    expect(all.jobs).toHaveLength(3);
    expect(new URL(calls[0]!.url).searchParams.get("first")).toBe("100");
    await whopBounties.search!({ query: "bnty_xxxxxxxxxxxx02" }, ctx);
    expect(new URL(calls[1]!.url).searchParams.get("query")).toBe("bnty_xxxxxxxxxxxx02");
  });

  it("answers auth_required with the help when the token is missing", async () => {
    await expect(whopBounties.search!({ query: "clip" }, testContext({ fetch: api() }))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("whop.com/dashboard/developer"),
    });
  });

  it("reads one bounty without a token, and past an expired one", async () => {
    const calls: Call[] = [];
    const job = await whopBounties.get!("bnty_xxxxxxxxxxxx01", testContext({ fetch: api(calls) }));
    expect(job?.title).toBe("Clip our Tuesday livestream");
    expect(calls[0]!.url).toBe("https://api.whop.com/api/v1/bounties/bnty_xxxxxxxxxxxx01");
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers["api-version-date"]).toBe(WHOP_API_VERSION);

    const expired: Override = (_url, _method, headers) =>
      headers.authorization ? jsonResponse({ error: { type: "unauthorized", message: "Authentication failed" } }, 401) : undefined;
    const again = await whopBounties.get!(
      "bnty_xxxxxxxxxxxx01",
      testContext({ fetch: api([], { override: expired }), credentials: CREDS }),
    );
    expect(again?.id).toBe("bnty_xxxxxxxxxxxx01");

    const capture = await whopBounties.get!("bnty_xxxxxxxxxxxx03", testContext({ fetch: api() }));
    const questions = capture?.requirements?.questions ?? [];
    expect(questions.map((q) => q.id)).toEqual(["city", "country", "device", "fov", "operator", "site", "station"]);
    expect(questions.filter((q) => !q.required).map((q) => q.id)).toEqual(["fov"]);
    expect(bountyToJob(ROWS[2]!)!.requirements?.questions).toBeUndefined();

    expect(await whopBounties.get!("12345", testContext({ fetch: api() }))).toBeNull();
    await expect(whopBounties.get!("bnty_missing", testContext({ fetch: api() }))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("whop-bounties apply, upload and submit", () => {
  it("keeps a draft on a standard bounty and sends links, files and caption in one submission", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const ctx = testContext({ fetch: api(calls), credentials: CREDS });

    const applied = await connector.apply!("bnty_xxxxxxxxxxxx02", {}, ctx);
    expect(applied).toMatchObject({ id: "bnty_xxxxxxxxxxxx02", job_id: "bnty_xxxxxxxxxxxx02", stage: "work_needed" });
    expect(applied.next).toContain("submit");
    expect(writes(calls)).toHaveLength(0);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const added = await connector.upload!("bnty_xxxxxxxxxxxx02", { kind: "file", name: "reveal.mp4", mime_type: "video/mp4", bytes }, ctx);
    const [createFile, put] = writes(calls);
    expect(createFile).toMatchObject({ url: "https://api.whop.com/api/v1/files", method: "POST", body: { filename: "reveal.mp4" } });
    expect(createFile!.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "api-version-date": WHOP_API_VERSION,
    });
    expect(createFile!.headers["idempotency-key"]).toMatch(UUID);
    expect(put).toMatchObject({ url: FILE.upload_url, method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes });
    expect(put!.headers.authorization).toBeUndefined();
    expect(added.file).toMatchObject({ id: "file_xxxxxxxxxxxxxx", name: "reveal.mp4", kind: "video/mp4", size: 4 });

    const link = "https://www.tiktok.com/@shinetime/video/7412345678901234567";
    const linked = await connector.upload!("bnty_xxxxxxxxxxxx02", { kind: "text", text: link }, ctx);
    expect(linked.progress).toEqual({ received: 2, wanted: 1, ready_to_submit: true });
    await expect(connector.upload!("bnty_xxxxxxxxxxxx02", { kind: "text", text: link }, ctx)).rejects.toMatchObject({
      code: "already_exists",
    });
    await expect(
      connector.upload!("bnty_xxxxxxxxxxxx02", { kind: "file", name: "reveal.mp4", mime_type: "video/mp4", bytes }, ctx),
    ).rejects.toMatchObject({
      code: "already_exists",
    });

    const sent = await connector.submit!("bnty_xxxxxxxxxxxx02", { note: "Vertical cut, 32 seconds." }, ctx);
    const post = writes(calls).at(-1)!;
    expect(post).toMatchObject({
      url: "https://api.whop.com/api/v1/bounty_submissions",
      method: "POST",
      body: {
        bounty_id: "bnty_xxxxxxxxxxxx02",
        deliverable: { urls: [link], file_ids: ["file_xxxxxxxxxxxxxx"], caption: "Vertical cut, 32 seconds." },
      },
    });
    expect(post.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "api-version-date": WHOP_API_VERSION,
    });
    expect(post.headers["idempotency-key"]).toMatch(UUID);
    expect(sent).toMatchObject({ id: "btys_new000000000001", job_id: "bnty_xxxxxxxxxxxx02", stage: "in_review" });
    expect(sent.next).toContain("28 USD");

    const after = await connector.status!("bnty_xxxxxxxxxxxx02", testContext({ fetch: api([], { submissions: [] }), credentials: CREDS }));
    expect(after).toBeNull();
  });

  it("removes a link or a file before submit, and needs work to submit", async () => {
    const connector = fresh();
    const ctx = testContext({ fetch: api([], { submissions: [] }), credentials: CREDS });
    await connector.apply!("bnty_xxxxxxxxxxxx02", { note: "Will post here: https://youtube.com/shorts/2" }, ctx);
    const removed = await connector.remove!("bnty_xxxxxxxxxxxx02", "https://youtube.com/shorts/2", ctx);
    expect(removed.removed).toEqual({ id: "https://youtube.com/shorts/2", name: "https://youtube.com/shorts/2" });
    expect(removed.progress?.ready_to_submit).toBe(false);
    await expect(connector.remove!("bnty_xxxxxxxxxxxx02", "file_nope", ctx)).rejects.toMatchObject({ code: "not_found" });
    await expect(connector.submit!("bnty_xxxxxxxxxxxx02", { note: "no links here" }, ctx)).rejects.toMatchObject({ code: "not_ready" });
    expect((await connector.status!("bnty_xxxxxxxxxxxx02", ctx))?.stage).toBe("work_needed");
  });

  it("claims a data-capture attempt with capture metadata and submits it with no payload", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const ctx = testContext({ fetch: api(calls, { submissions: [] }), credentials: CREDS });
    const claimed = await connector.apply!("bnty_xxxxxxxxxxxx03", { answers: { ...CAPTURE_ANSWERS, fov: "120" } }, ctx);
    const post = writes(calls)[0]!;
    expect(post).toMatchObject({
      url: "https://api.whop.com/api/v1/bounty_submissions",
      method: "POST",
      body: {
        bounty_id: "bnty_xxxxxxxxxxxx03",
        metadata: {
          city: "Austin",
          country: "US",
          device: "iPhone 15 Pro",
          operator: "mwebb",
          site: "BurnetRd",
          station: "Bay2",
          fov: 120,
        },
      },
    });
    expect((post.body as Rec).deliverable).toBeUndefined();
    expect(post.headers["idempotency-key"]).toMatch(UUID);
    expect(claimed).toMatchObject({
      id: "btys_capture00000001",
      stage: "work_needed",
      progress: { received: 0, wanted: 120, ready_to_submit: false },
    });
    expect(claimed.next).toContain("Whop app");

    const attempt = {
      ...SUBMISSION,
      id: "btys_capture00000001",
      bounty_id: "bnty_xxxxxxxxxxxx03",
      status: "in_progress",
      deliverable_type: "data_capture",
    };
    const submitCalls: Call[] = [];
    const sent = await connector.submit!(
      "btys_capture00000001",
      { note: "All footage recorded." },
      testContext({ fetch: api(submitCalls, { submissions: [attempt] }), credentials: CREDS }),
    );
    const submitPost = writes(submitCalls)[0]!;
    expect(submitPost).toMatchObject({ url: "https://api.whop.com/api/v1/bounty_submissions/btys_capture00000001/submit", method: "POST" });
    expect(submitPost.body).toBeUndefined();
    expect(submitPost.headers["idempotency-key"]).toMatch(UUID);
    expect(sent.stage).toBe("in_review");

    const short: Override = (url, method) =>
      method === "POST" && url.pathname.endsWith("/submit")
        ? jsonResponse({ error: { type: "bad_request", message: "The attempt has not accumulated enough verified footage." } }, 400)
        : undefined;
    await expect(
      connector.submit!(
        "btys_capture00000001",
        {},
        testContext({ fetch: api([], { submissions: [attempt], override: short }), credentials: CREDS }),
      ),
    ).rejects.toMatchObject({ code: "not_ready", message: expect.stringContaining("not accumulated enough") });
  });

  it("refuses partial or mistyped capture metadata before claiming, and claims bare when the spec lists none", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const ctx = testContext({ fetch: api(calls, { submissions: [] }), credentials: CREDS });
    const partial = { city: "Austin", country: "US", operator: "mwebb", site: "BurnetRd", station: "Bay2" };
    await expect(connector.apply!("bnty_xxxxxxxxxxxx03", { answers: partial }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("answer device"),
      details: { missing: ["device"] },
    });
    await expect(connector.apply!("bnty_xxxxxxxxxxxx03", {}, ctx)).rejects.toMatchObject({
      code: "invalid_input",
      details: { missing: ["city", "country", "device", "operator", "site", "station"] },
    });
    await expect(connector.apply!("bnty_xxxxxxxxxxxx03", { answers: { ...CAPTURE_ANSWERS, fov: "120.5" } }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("whole degrees"),
    });
    expect(writes(calls)).toHaveLength(0);

    const bare: Override = (url, method) =>
      method === "GET" && url.pathname.endsWith("/bnty_xxxxxxxxxxxx03") ? { ...ROWS[2]!, capture_spec: null } : undefined;
    const bareCalls: Call[] = [];
    const claimed = await connector.apply!(
      "bnty_xxxxxxxxxxxx03",
      {},
      testContext({ fetch: api(bareCalls, { submissions: [], override: bare }), credentials: CREDS }),
    );
    expect(writes(bareCalls)[0]!.body).toEqual({ bounty_id: "bnty_xxxxxxxxxxxx03" });
    expect(claimed.stage).toBe("work_needed");
    await expect(
      connector.apply!(
        "bnty_xxxxxxxxxxxx03",
        { answers: { city: "Austin" } },
        testContext({ fetch: api([], { submissions: [], override: bare }), credentials: CREDS }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input", details: { missing: ["country", "device", "operator", "site", "station"] } });
  });

  it("returns the attempt already under review instead of a second one, and refuses closed bounties", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const reviewing = { ...SUBMISSION, status: "submitted", resolved_at: null };
    const app = await connector.apply!(
      "bnty_xxxxxxxxxxxx01",
      {},
      testContext({ fetch: api(calls, { submissions: [reviewing] }), credentials: CREDS }),
    );
    expect(app).toMatchObject({ id: "btys_xxxxxxxxxxxxxx", stage: "in_review" });
    expect(writes(calls)).toHaveLength(0);

    const closed: Override = (url, method) =>
      method === "GET" && url.pathname.endsWith("/bnty_xxxxxxxxxxxx02") ? { ...ROWS[1]!, status: "closed" } : undefined;
    const error = await connector.apply!(
      "bnty_xxxxxxxxxxxx02",
      {},
      testContext({ fetch: api([], { submissions: [], override: closed }), credentials: CREDS }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error).toMatchObject({ code: "wrong_stage" });
  });
});

describe("whop-bounties follow up and get paid", () => {
  it("lists only the person's own submissions, with titles", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const apps = await connector.list!(testContext({ fetch: api(calls), credentials: CREDS }));
    expect(apps.map((a) => a.id)).toEqual(["btys_xxxxxxxxxxxxxx"]);
    expect(apps[0]).toMatchObject({ job_title: "Clip our Tuesday livestream", stage: "accepted" });
    expect(calls.some((c) => c.url.includes("/bounties?user_id=user_xxxxxxxxxxxxxx"))).toBe(true);
    const status = await connector.status!("btys_xxxxxxxxxxxxxx", testContext({ fetch: api(), credentials: CREDS }));
    expect(status).toMatchObject({ stage: "accepted", review: { earned: { amount: 17.5, currency: "USD" } } });
  });

  it("reads the balance, approved rewards, payouts and saved methods", async () => {
    const earnings = await fresh().earnings!(testContext({ fetch: api(), credentials: CREDS }));
    expect(earnings).toMatchObject({
      balance: { amount: 250, currency: "USD" },
      total_earned: { amount: 750, currency: "USD" },
      pending: { amount: 10, currency: "USD" },
      entries: [
        { id: "btys_xxxxxxxxxxxxxx", amount: 17.5, currency: "USD", status: "available", job_title: "Clip our Tuesday livestream" },
      ],
      payouts: [{ id: "wdrl_xxxxxxxxxxxxx", amount: { amount: 125.5, currency: "USD" }, method: "Operating account", status: "paid" }],
      methods: ["pyot_xxxxxxxxxxxx01 (Business checking, default)", "pyot_xxxxxxxxxxxx02 (PayPal)"],
    });
  });

  it("pays the withdrawable balance out to the saved method the person names", async () => {
    const calls: Call[] = [];
    const payout = await fresh().payout!(
      { method: "paypal", note: "October bounties" },
      testContext({ fetch: api(calls), credentials: CREDS }),
    );
    const post = writes(calls)[0]!;
    expect(post).toMatchObject({
      url: "https://api.whop.com/api/v1/payouts",
      method: "POST",
      body: {
        user_id: "user_xxxxxxxxxxxxxx",
        amount: 250,
        currency: "usd",
        payout_method_id: "pyot_xxxxxxxxxxxx02",
        notes: "October bounties",
      },
    });
    expect(post.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "api-version-date": WHOP_API_VERSION });
    expect(post.headers["idempotency-key"]).toMatch(UUID);
    expect(payout).toMatchObject({
      id: "wdrl_new0000000001",
      amount: { amount: 250, currency: "USD" },
      method: "PayPal",
      status: "requested",
    });

    const direct: Call[] = [];
    await fresh().payout!({ amount: 50, method: "pyot_xxxxxxxxxxxx01" }, testContext({ fetch: api(direct), credentials: CREDS }));
    expect(direct.map((c) => c.url)).toContain("https://api.whop.com/api/v1/payouts/methods?user_id=user_xxxxxxxxxxxxxx&first=100");
    expect(writes(direct)[0]!.body).toEqual({ user_id: "user_xxxxxxxxxxxxxx", amount: 50, payout_method_id: "pyot_xxxxxxxxxxxx01" });

    // A delivery type is a word to match, never an id to send.
    const rail: Call[] = [];
    await fresh().payout!({ amount: 20, method: "bank_deposit" }, testContext({ fetch: api(rail), credentials: CREDS }));
    expect((writes(rail)[0]!.body as Rec).payout_method_id).toBe("pyot_xxxxxxxxxxxx01");

    await expect(fresh().payout!({ method: "venmo" }, testContext({ fetch: api(), credentials: CREDS }))).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("pyot_xxxxxxxxxxxx01"),
    });
  });

  it("rounds a whole-balance payout down to the cent and keeps notes within 255 characters", async () => {
    const calls: Call[] = [];
    const balance = USER.balance as Rec;
    const cash = [{ ...(balance.cash as Rec[])[0]!, balance: 10.125, balance_usd: 10.125, total_withdrawable_balance: 10.125 }];
    const odd: Override = (url) => (url.pathname.endsWith("/users/me") ? { ...USER, balance: { ...balance, cash } } : undefined);
    await fresh().payout!(
      { method: "default", note: "x".repeat(300) },
      testContext({ fetch: api(calls, { override: odd }), credentials: CREDS }),
    );
    const body = writes(calls)[0]!.body as Rec;
    expect(body).toMatchObject({ amount: 10.12, currency: "usd", payout_method_id: "pyot_xxxxxxxxxxxx01" });
    expect((body.notes as string).length).toBeLessThanOrEqual(255);
  });

  it("reports the account, signed in or not", async () => {
    expect(await whopBounties.account!(testContext({ fetch: api() }))).toMatchObject({ signed_in: false });
    expect(await fresh().account!(testContext({ fetch: api(), credentials: CREDS }))).toMatchObject({
      signed_in: true,
      label: "danawhitfield",
      ready: true,
    });
  });
});

describe("paid engagement", () => {
  it("leaves follow, like, comment and post-on-order bounties out of search, and keeps real work", () => {
    for (const title of [
      "Follow @datsq9 & Fully Engage Instagram Posts (10  Accounts)",
      "Fully Engage Social Media Posts (TMS)",
      "Enage with X article",
      "Engage With Last 15 Posts on X + Follow",
      "Like, Share & Comment on Vonn.5 Post (US Only)",
      "💸 Get Paid To Follow Us On X (Less Than 1 Minute)",
      "Post BRIANYCNR in 3 Reddit Waymo threads",
      "Like, Share & Follow IG + Join Telegram @biggerbettorsports",
      "Follow @brand on TikTok",
    ])
      expect(isPaidEngagement(title), title).toBe(true);
    for (const title of [
      "Clip 5 Shane Gillis moments for Whop AI's entertainment tab",
      "Film a 30-second UGC testimonial for My Solar Claim",
      "Play Music Tower Stacker on camera — $5 per video",
      "Generate 1 Paid Sale via Affiliate Link, Earn $5",
      "Post a 30-second review video of the app on TikTok",
      "Make 3 short clips from our podcast and post them on your page",
    ])
      expect(isPaidEngagement(title), title).toBe(false);
  });
});
