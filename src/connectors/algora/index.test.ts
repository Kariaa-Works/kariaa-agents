import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, jsonResponse, testContext } from "../../core/conformance.js";
import { ProtocolError } from "../../core/errors.js";
import { NativeApplicationSchema, NativeJobSchema } from "../../core/types.js";
import {
  ALGORA_BOT,
  bountyFromComments,
  closedReason,
  confirmToken,
  createAlgora,
  DEFAULT_ALGORA_ORGS,
  issueToJob,
  orgsFrom,
  parseIssueId,
} from "./index.js";

type Rec = Record<string, unknown>;
const read = <T = Rec>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as T;

// Captured live on 2026-10-27 with read-only GETs: the issue search over tscircuit, zio and coollabsio, the comments
// of each hit, a rewarded issue (tscircuit/template-api-fake#2) and a pull request. user.json and comment-created.json
// follow GitHub's REST reference, since they need a token.
const SEARCH = read("search");
const ITEMS = SEARCH.items as Rec[];
const COMMENTS = read<Record<string, Rec[]>>("comments");
const REWARDED_ISSUE = read("rewarded-issue");
const REWARDED_COMMENTS = read<Rec[]>("rewarded-comments");
const PULL = read("pull");
const USER = read("user");
const CREATED = read("comment-created");
const TOKEN = "ghp_test";
const CREDS = { GITHUB_TOKEN: TOKEN };
const OPEN_ID = "tscircuit/pcb-viewer#163";

type Call = { url: URL; method: string; headers: Record<string, string>; body: Rec | undefined };
type Fake = {
  login?: string;
  /** x-oauth-scopes; null leaves the header out (a fine-grained token). */
  scopes?: string | null;
  pull?: Rec;
  override?: (url: URL, method: string) => unknown;
};

const keyOf = (item: Rec) => `${String(item.repository_url).replace("https://api.github.com/repos/", "")}#${String(item.number)}`;

/** A fake GitHub: the captured search, issues and comments; /user and every write want the test token. */
function github(calls: Call[] = [], fake: Fake = {}) {
  const posted: Record<string, Rec[]> = {};
  const issues: Record<string, Rec> = Object.fromEntries([...ITEMS.map((i) => [keyOf(i), i]), [keyOf(REWARDED_ISSUE), REWARDED_ISSUE]]);
  const comments: Record<string, Rec[]> = { ...COMMENTS, [keyOf(REWARDED_ISSUE)]: REWARDED_COMMENTS };
  const login = fake.login ?? "octocat";
  return fixtureFetch((raw, init) => {
    const url = new URL(raw);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Rec) : undefined;
    calls.push({ url, method, headers, body });
    const custom = fake.override?.(url, method);
    if (custom !== undefined) return custom;
    const authed = headers.authorization === `Bearer ${TOKEN}`;
    if (url.pathname === "/search/issues") return SEARCH;
    if (url.pathname === "/user") {
      if (!authed) return jsonResponse({ message: "Bad credentials" }, 401);
      const scopes = fake.scopes === undefined ? "public_repo, read:user" : fake.scopes;
      return jsonResponse({ ...USER, login }, 200, scopes === null ? {} : { "x-oauth-scopes": scopes });
    }
    const pull = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/u.exec(url.pathname);
    if (pull) return fake.pull ?? PULL;
    const match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/comments)?$/u.exec(url.pathname);
    if (match) {
      const key = `${match[1]}/${match[2]}#${match[3]}`;
      if (match[4] && method === "POST") {
        if (!authed) return jsonResponse({ message: "Requires authentication" }, 401);
        const created = {
          ...CREATED,
          body: body?.body,
          html_url: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}#issuecomment-${calls.length}`,
          user: { login, type: "User" },
        };
        (posted[key] ??= []).push(created);
        return jsonResponse(created, 201);
      }
      if (match[4]) return [...(comments[key] ?? []), ...(posted[key] ?? [])];
      return issues[key] ?? jsonResponse({ message: "Not Found" }, 404);
    }
    return jsonResponse({ message: "Not Found" }, 404);
  });
}

const connector = (fake: Fake = {}, calls: Call[] = []) => {
  const algora = createAlgora({ stateFile: null, env: {} });
  const ctx = (credentials: Record<string, string> = CREDS) => testContext({ fetch: github(calls, fake), credentials });
  return { algora, ctx, calls };
};
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describeConnectorConformance(createAlgora({ stateFile: null, env: {} }), { search: { query: "viewer" }, fetch: github() });

describe("algora: reading the bot's comments", () => {
  it("prices a bounty from algora-pbc[bot]'s comment, with its attempts and claims", () => {
    const bounty = bountyFromComments(COMMENTS[OPEN_ID]!);
    expect(bounty).toMatchObject({
      total: 3,
      sponsors: [{ name: "tscircuit", amount: 3, url: "https://algora.io/tscircuit" }],
      posted_at: "2025-02-15T18:11:25.000Z",
      awards: [],
      claims: [{ login: "zalabhavy", pr: "https://github.com/tscircuit/pcb-viewer/pull/169" }],
    });
    expect(bounty!.attempts.map((a) => a.login)).toEqual(["Anshgrover23", "zalabhavy"]);
  });

  it("takes the latest pricing comment as the whole bounty when sponsors join", () => {
    const bounty = bountyFromComments(COMMENTS["coollabsio/coolify#2389"]!)!;
    // The 2025 comment relists all five sponsors ("Martynas Sklizmantas" became "Marty"): no double counting.
    expect(bounty.sponsors).toHaveLength(5);
    expect(bounty.total).toBe(423);
    expect(bounty.posted_at).toBe("2024-06-08T17:47:01.000Z");
  });

  it("reads the older 'created by' format and sums several sponsors in one comment", () => {
    const old = bountyFromComments([{ user: { login: ALGORA_BOT }, body: "💎 **$100.00** bounty created by dm161\n🙋 comment below" }]);
    expect(old).toMatchObject({ total: 100, sponsors: [{ name: "dm161", amount: 100 }] });
    const two = bountyFromComments([
      {
        user: { login: ALGORA_BOT },
        body: "## 💎 $150 bounty [• Calvin Lee Fernandes](https://console.algora.io/org/calvinlfer)\n## 💎 $1,500 bounty [• ZIO](https://console.algora.io/org/ZIO)",
      },
    ]);
    expect(two!.total).toBe(1650);
  });

  it("ignores a look-alike bounty comment from any other account (label farms copy Algora's text)", () => {
    const farm = [{ user: { login: "clanker-journalist[bot]" }, body: "## 💎 $8700 bounty\n\n### 🚀 Steps to solve:" }];
    expect(bountyFromComments(farm)).toBeNull();
    expect(closedReason({ state: "open", labels: [{ name: "💎 Bounty" }, { name: "$8k" }] }, null)).toMatch(/not priced/u);
  });

  it("sees an award, with or without the sponsor's name after it", () => {
    expect(bountyFromComments(REWARDED_COMMENTS)!.awards).toEqual([
      { login: "MustafaMulla29", amount: 12, at: "2025-05-12T17:06:14.000Z" },
    ]);
    const fileServer = bountyFromComments(COMMENTS["tscircuit/file-server#5"]!)!;
    expect(fileServer.awards[0]).toMatchObject({ login: "ArnavK-09", amount: 10 });
    expect(closedReason(REWARDED_ISSUE, bountyFromComments(REWARDED_COMMENTS))).toBe("Already awarded to @MustafaMulla29");
  });
});

describe("algora: mapping", () => {
  it("maps an open bounty issue to a claimable task", () => {
    const item = ITEMS.find((i) => keyOf(i) === OPEN_ID)!;
    const job = issueToJob(item, bountyFromComments(COMMENTS[OPEN_ID]!))!;
    expect(NativeJobSchema.safeParse(job).success).toBe(true);
    expect(job).toMatchObject({
      id: OPEN_ID,
      kind: "task",
      title: "Remove `disableAutoFocus` in favor of `focusOnHover={false}`",
      org: "tscircuit",
      url: "https://github.com/tscircuit/pcb-viewer/issues/163",
      pay: { min: 3, max: 3, currency: "USD", period: "unit", text: "$3 from tscircuit" },
      participation_mode: "claim",
      posted_at: "2025-02-15T18:11:25.000Z",
    });
    expect(job.stages).toBeUndefined();
    expect(job.tags).toEqual(expect.arrayContaining(["tscircuit/pcb-viewer", "2 attempts", "1 claim", "source:algora"]));
    expect(job.tags).not.toContain("💎 Bounty");
  });

  it("narrows a restricted, rewarded or closed bounty to search and get", () => {
    const core = ITEMS.find((i) => keyOf(i) === "coollabsio/coolify#2378")!;
    const job = issueToJob(core, bountyFromComments(COMMENTS["coollabsio/coolify#2378"]!))!;
    expect(job.stages).toEqual(["search", "get"]);
    expect(job.apply_hint).toMatch(/Core Team Only/u);
    expect(job.pay?.min).toBe(130);
    const rewarded = issueToJob(REWARDED_ISSUE, bountyFromComments(REWARDED_COMMENTS))!;
    expect(rewarded.stages).toEqual(["search", "get"]);
    expect(issueToJob({ ...core, state: "closed", labels: [] }, bountyFromComments(COMMENTS["coollabsio/coolify#2378"]!))!.stages).toEqual([
      "search",
      "get",
    ]);
  });

  it("parses ids and issue URLs", () => {
    expect(parseIssueId("tscircuit/pcb-viewer#163")).toEqual({ owner: "tscircuit", repo: "pcb-viewer", number: 163 });
    expect(parseIssueId("https://github.com/zio/zio/issues/9211")).toEqual({ owner: "zio", repo: "zio", number: 9211 });
    expect(parseIssueId("tscircuit/pcb-viewer/163")).toBeNull();
    expect(parseIssueId("nope")).toBeNull();
  });

  it("reads ALGORA_ORGS, deduplicated, falling back to the curated list", () => {
    expect(orgsFrom(undefined)).toEqual([...DEFAULT_ALGORA_ORGS]);
    expect(orgsFrom(" zio, ZIO ,bad/name, tscircuit ")).toEqual(["zio", "tscircuit"]);
    expect(orgsFrom(" , ")).toEqual([...DEFAULT_ALGORA_ORGS]);
  });
});

describe("algora: search and get", () => {
  it("searches only the trusted organisations for issues algora-pbc[bot] commented on", async () => {
    const { algora, ctx, calls } = connector();
    const { jobs } = await algora.search!({ query: "viewer repo:evil/farm org:farm" }, ctx({}));
    const searches = calls.filter((c) => c.url.pathname === "/search/issues").map((c) => c.url.searchParams.get("q")!);
    expect(searches.length).toBeGreaterThan(0);
    for (const q of searches) {
      expect(q.length).toBeLessThanOrEqual(256);
      expect(q).toContain(`commenter:${ALGORA_BOT}`);
      expect(q).toContain("state:open");
      expect(q).not.toMatch(/evil|farm/u);
    }
    const orgs = searches.flatMap((q) => [...q.matchAll(/org:(\S+)/gu)].map((m) => m[1]));
    expect(orgs).toEqual([...DEFAULT_ALGORA_ORGS]);
    // Core-team-only and on-hold coolify bounties and the rewarded file-server one stay out.
    expect(jobs.map((j) => j.id)).toEqual([OPEN_ID]);
    // The rewarded issue is dropped by its label before its comments are read.
    expect(calls.some((c) => c.url.pathname.includes("/file-server/issues/5/comments"))).toBe(false);
  });

  it("splits a long organisation list across searches under GitHub's query limit", async () => {
    const orgs = Array.from({ length: 30 }, (_, i) => `organisation-number-${i}`);
    const calls: Call[] = [];
    const algora = createAlgora({ stateFile: null, orgs });
    await algora.search!({}, testContext({ fetch: github(calls) }));
    const searches = calls.filter((c) => c.url.pathname === "/search/issues").map((c) => c.url.searchParams.get("q")!);
    expect(searches.length).toBeGreaterThan(1);
    for (const q of searches) expect(q.length).toBeLessThanOrEqual(256);
    expect(searches.flatMap((q) => [...q.matchAll(/org:(\S+)/gu)].map((m) => m[1]))).toEqual(orgs);
  });

  it("applies pay_min after pricing", async () => {
    const { algora, ctx } = connector();
    expect((await algora.search!({ pay_min: 5 }, ctx({}))).jobs).toEqual([]);
    expect((await algora.search!({ pay_min: 3 }, ctx({}))).jobs).toHaveLength(1);
  });

  it("gets one bounty, and null for an unknown id or an issue without a bounty", async () => {
    const { algora, ctx } = connector();
    expect((await algora.get!(OPEN_ID, ctx({})))?.pay?.min).toBe(3);
    expect(await algora.get!("tscircuit/pcb-viewer#999999", ctx({}))).toBeNull();
    expect(await algora.get!("not an id", ctx({}))).toBeNull();
  });

  it("maps GitHub's rate limit to rate_limited with a retry time", async () => {
    const { algora, ctx } = connector({
      override: (url) =>
        url.pathname === "/search/issues"
          ? jsonResponse({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "retry-after": "42" })
          : undefined,
    });
    const error = await algora.search!({}, ctx({})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("rate_limited");
    expect((error as ProtocolError).retry_after).toBe(42);
  });
});

describe("algora: attempt and claim", () => {
  it("needs GITHUB_TOKEN for apply, submit, status and list with attempts", async () => {
    const { algora, ctx } = connector();
    for (const run of [
      () => algora.apply!(OPEN_ID, {}, ctx({})),
      () => algora.submit!(OPEN_ID, { note: "confirm:abc" }, ctx({})),
      () => algora.status!(OPEN_ID, ctx({})),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "auth_required" });
    }
    expect(await algora.list!(ctx({}))).toEqual([]);
  });

  it("drafts the attempt without posting, and posts it only with the matching confirmation", async () => {
    const { algora, ctx, calls } = connector();
    const app = await algora.apply!(OPEN_ID, { note: "Swap the prop in PCBViewer and update the stories." }, ctx());
    expect(NativeApplicationSchema.safeParse(app).success).toBe(true);
    expect(app).toMatchObject({ id: OPEN_ID, job_id: OPEN_ID, stage: "work_needed" });
    const raw = app.raw as { confirm: string; comment: string };
    expect(raw.comment).toBe("/attempt #163\n\nSwap the prop in PCBViewer and update the stories.");
    expect(app.next).toContain(`confirm:${raw.confirm}`);
    expect(app.next).toMatch(/already attempted/u);
    expect(writes(calls)).toEqual([]);

    await expect(algora.submit!(OPEN_ID, {}, ctx())).rejects.toMatchObject({ code: "invalid_input" });
    await expect(algora.submit!(OPEN_ID, { note: "confirm:000000000000" }, ctx())).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/does not match/u),
    });
    expect(writes(calls)).toEqual([]);

    const done = await algora.submit!(OPEN_ID, { note: `confirm:${raw.confirm}` }, ctx());
    const posts = writes(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url.pathname).toBe("/repos/tscircuit/pcb-viewer/issues/163/comments");
    expect(posts[0]!.body).toEqual({ body: raw.comment });
    expect(posts[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(done.stage).toBe("work_needed");
    expect(done.next).toMatch(/pr:<PR URL>/u);
    expect(done.url).toMatch(/issuecomment-/u);

    // Confirming again posts nothing new.
    await algora.submit!(OPEN_ID, { note: `confirm:${raw.confirm}` }, ctx());
    expect(writes(calls)).toHaveLength(1);
  });

  it("ties the token to the drafted comment", () => {
    const base = { nonce: "n", issue: OPEN_ID, comment: "/attempt #163" };
    expect(confirmToken(base)).toMatch(/^[0-9a-f]{12}$/u);
    expect(confirmToken({ ...base, comment: "/attempt #163\n\nother plan" })).not.toBe(confirmToken(base));
  });

  it("refuses to draft an attempt on a rewarded bounty", async () => {
    const { algora, ctx } = connector();
    await expect(algora.apply!("tscircuit/template-api-fake#2", {}, ctx())).rejects.toMatchObject({ code: "wrong_stage" });
    await expect(algora.apply!("nope", {}, ctx())).rejects.toMatchObject({ code: "not_found" });
  });

  it("claims only with a pull request the person opened", async () => {
    const { algora, ctx, calls } = connector({ login: "octocat" });
    const pr = "pr:https://github.com/tscircuit/pcb-viewer/pull/169";
    await expect(algora.submit!(OPEN_ID, { note: pr }, ctx())).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/opened by @zalabhavy, not @octocat/u),
    });
    await expect(algora.submit!(OPEN_ID, { note: "pr:https://example.com/x" }, ctx())).rejects.toMatchObject({ code: "invalid_input" });
    expect(writes(calls)).toEqual([]);
  });

  it("posts /claim on the person's own pull request and moves to review", async () => {
    const pull = { ...PULL, state: "open", body: "Fixes the prop." };
    const { algora, ctx, calls } = connector({ login: "zalabhavy", pull });
    // The claim is drafted first: nothing is posted until the person confirms it.
    const draft = await algora.submit!(OPEN_ID, { note: "pr: https://github.com/tscircuit/pcb-viewer/pull/169" }, ctx());
    expect(writes(calls)).toEqual([]);
    expect(draft.stage).toBe("work_needed");
    expect(draft.next).toContain("/claim #163");
    const token = /confirm:([0-9a-f]{12})/u.exec(draft.next ?? "")![1]!;
    await expect(algora.submit!(OPEN_ID, { note: "confirm:000000000000" }, ctx())).rejects.toMatchObject({ code: "invalid_input" });
    expect(writes(calls)).toEqual([]);
    const app = await algora.submit!(OPEN_ID, { note: `confirm:${token}` }, ctx());
    const posts = writes(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url.pathname).toBe("/repos/tscircuit/pcb-viewer/issues/169/comments");
    expect(posts[0]!.body).toEqual({ body: "/claim #163" });
    expect(app.stage).toBe("in_review");
    expect(app.next).toMatch(/Stripe Connect/u);
    // Already claimed with this pull request: nothing new is posted.
    await algora.submit!(OPEN_ID, { note: "pr:https://github.com/tscircuit/pcb-viewer/pull/169" }, ctx());
    expect(writes(calls)).toHaveLength(1);
  });

  it("does not post a claim the pull request's description already makes, and refuses a closed unmerged one", async () => {
    const open = connector({ login: "zalabhavy", pull: { ...PULL, state: "open" } });
    const app = await open.algora.submit!(OPEN_ID, { note: "pr:https://github.com/tscircuit/pcb-viewer/pull/169" }, open.ctx());
    expect(writes(open.calls)).toEqual([]);
    expect(app.next).toMatch(/already says/u);
    const closed = connector({ login: "zalabhavy" });
    await expect(
      closed.algora.submit!(OPEN_ID, { note: "pr:https://github.com/tscircuit/pcb-viewer/pull/169" }, closed.ctx()),
    ).rejects.toMatchObject({
      code: "wrong_stage",
    });
  });

  it("uses the full issue URL when the pull request lives in another repository", async () => {
    const pull = { ...PULL, state: "open", body: "", html_url: "https://github.com/tscircuit/core/pull/7" };
    const { algora, ctx, calls } = connector({ login: "zalabhavy", pull });
    const draft = await algora.submit!(OPEN_ID, { note: "pr:https://github.com/tscircuit/core/pull/7" }, ctx());
    const token = /confirm:([0-9a-f]{12})/u.exec(draft.next ?? "")![1]!;
    await algora.submit!(OPEN_ID, { note: `confirm:${token}` }, ctx());
    expect(writes(calls)[0]).toMatchObject({ body: { body: "/claim https://github.com/tscircuit/pcb-viewer/issues/163" } });
    expect(writes(calls)[0]!.url.pathname).toBe("/repos/tscircuit/core/issues/7/comments");
  });

  it("reads status from the issue: the person's award, someone else's, or their attempt", async () => {
    const won = connector({ login: "MustafaMulla29" });
    const accepted = await won.algora.status!("tscircuit/template-api-fake#2", won.ctx());
    expect(accepted).toMatchObject({ stage: "accepted", review: { earned: { amount: 12, currency: "USD" } } });
    const lost = connector({ login: "Anshgrover23" });
    expect(await lost.algora.status!("tscircuit/template-api-fake#2", lost.ctx())).toBeNull();
    expect(await lost.algora.status!(OPEN_ID, lost.ctx())).toMatchObject({ stage: "work_needed" });
    const claimed = connector({ login: "zalabhavy" });
    expect(await claimed.algora.status!(OPEN_ID, claimed.ctx())).toMatchObject({
      stage: "in_review",
      raw: { pull_request: "https://github.com/tscircuit/pcb-viewer/pull/169" },
    });
    const list = await claimed.algora.list!(claimed.ctx());
    expect(list.map((a) => a.id)).toEqual([OPEN_ID]);
  });

  it("links to the issue, or to the posted comment", async () => {
    const { algora } = connector();
    expect(await algora.link!(OPEN_ID)).toEqual({ url: "https://github.com/tscircuit/pcb-viewer/issues/163" });
  });
});

describe("algora: account", () => {
  it("says what is missing without a token, and checks the token can comment", async () => {
    const { algora, ctx } = connector();
    expect(await algora.account!(ctx({}))).toMatchObject({ signed_in: false, missing: ["GITHUB_TOKEN"] });
    expect(await algora.account!(ctx())).toMatchObject({ signed_in: true, label: "octocat", ready: true });
    const noScope = connector({ scopes: "read:user" });
    expect(await noScope.algora.account!(noScope.ctx())).toMatchObject({ ready: false, missing: ["the public_repo scope"] });
    const fine = connector({ scopes: null });
    expect(await fine.algora.account!(fine.ctx())).toMatchObject({ ready: false, missing: [expect.stringMatching(/classic token/u)] });
  });

  it("maps a refused token to auth_required", async () => {
    const { algora, ctx } = connector();
    await expect(algora.account!(ctx({ GITHUB_TOKEN: "expired" }))).rejects.toMatchObject({ code: "auth_required" });
  });
});
