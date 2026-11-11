import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, jsonResponse, testContext } from "../../core/conformance.js";
import { listingToJob, superteamEarn } from "./index.js";

const listings = JSON.parse(readFileSync(new URL("./fixtures/listings.json", import.meta.url), "utf8")) as unknown;
const detail = JSON.parse(readFileSync(new URL("./fixtures/detail.json", import.meta.url), "utf8")) as unknown;

const api = fixtureFetch((url) => {
  if (url.endsWith("/listings?take=100")) return listings;
  if (url.endsWith("/listings/details/travel-boost-for-bp26")) return detail;
  if (url.includes("/listings/details/")) return jsonResponse({ error: "Listing not found" }, 404);
  return jsonResponse("?", 500);
});

describeConnectorConformance(superteamEarn, { search: { query: "content" }, fetch: api, minResults: 1, expectQueryInUrl: false });

describe("superteam-earn", () => {
  it("maps list rows and filters the words here", async () => {
    const ctx = testContext({ fetch: api });
    const all = await superteamEarn.search!({}, ctx);
    expect(all.jobs).toHaveLength(4);
    expect(all.jobs[0]).toMatchObject({
      id: "travel-boost-for-bp26",
      kind: "task",
      org: "Superteam Germany",
      pay: { min: 6000, max: 6000, currency: "USDG", period: "unit", text: "6,000 USDG" },
      expires_at: "2026-10-25T21:59:59.000Z",
      url: "https://superteam.fun/earn/listing/travel-boost-for-bp26",
    });
    expect(all.jobs[0]!.tags).toEqual(["bounty", "human-only", "featured", "source:superteam"]);
    const { jobs } = await superteamEarn.search!({ query: "security audit" }, ctx);
    expect(jobs.map((j) => j.id)).toEqual(["vaultline-security-audit-grants-for-colosseum-projects-up-to-4000-usdc-each"]);
  });

  it("reads one listing with its skills, region and submission questions", async () => {
    const job = await superteamEarn.get!("travel-boost-for-bp26", testContext({ fetch: api }));
    expect(job).toMatchObject({
      id: "travel-boost-for-bp26",
      location: { remote: true, text: "Germany" },
      posted_at: "2026-10-15T08:22:01.267Z",
    });
    expect(job!.tags).toEqual(["bounty", "human-only", "Content", "Writing", "Social Media", "Video", "source:superteam"]);
    expect(job!.description).toContain("The submission asks for:");
    expect(job!.description).not.toContain("<p");
    await expect(superteamEarn.get!("nope", testContext({ fetch: api }))).rejects.toMatchObject({ code: "not_found" });
    expect(await superteamEarn.get!("Not Valid", testContext({ fetch: api }))).toBeNull();
  });

  it("maps projects, ranges and variable pay", () => {
    expect(
      listingToJob({
        slug: "p",
        title: "Build a dapp",
        type: "project",
        compensationType: "range",
        minRewardAsk: 500,
        maxRewardAsk: 1500,
        token: "USDC",
        status: "OPEN",
      }),
    ).toMatchObject({
      kind: "listing",
      pay: { min: 500, max: 1500, currency: "USDC", unit: "per project", text: "500–1500 USDC" },
    });
    expect(
      listingToJob({ slug: "v", title: "Variable", type: "bounty", compensationType: "variable", token: "SOL", status: "CLOSED" }),
    ).toMatchObject({
      pay: { currency: "SOL", text: "variable, paid in SOL" },
      stages: ["search", "get"],
    });
    expect(listingToJob({ title: "no slug" })).toBeNull();
  });
});

const AGENT_LISTING = {
  id: "11111111-2222-4333-8444-555555555555",
  slug: "agent-docs-bounty",
  title: "Write SDK docs",
  type: "bounty",
  status: "OPEN",
  agentAccess: "AGENT_ALLOWED",
  compensationType: "fixed",
  rewardAmount: 500,
  token: "USDC",
  deadline: "2026-11-20T00:00:00.000Z",
  isWinnersAnnounced: false,
  eligibility: [
    { type: "text", order: 2, optional: true, question: "Anything else?" },
    { type: "link", order: 1, optional: null, question: "Link to the docs PR" },
  ],
};

function agentApi(calls: { url: string; init?: RequestInit }[], opts: { duplicate?: boolean } = {}) {
  return fixtureFetch((url, init) => {
    calls.push({ url, init });
    const authed = (init?.headers as Record<string, string> | undefined)?.authorization === "Bearer sk_test";
    if (url.endsWith("/api/agents") && init?.method === "POST")
      return { apiKey: "sk_new", claimCode: "CLAIM1", agentId: "a1", username: "kariaa-agent" };
    if (url.includes("/api/agents/") && !authed) return jsonResponse({ error: "Unauthorized" }, 401);
    if (url.endsWith("/api/listings?take=100"))
      return [
        { ...AGENT_LISTING, slug: "agent-docs-bounty" },
        { ...AGENT_LISTING, slug: "public-one", agentAccess: "HUMAN_ONLY" },
      ];
    if (url.includes("/agents/listings/live")) return [AGENT_LISTING, { ...AGENT_LISTING, slug: "agent-only", agentAccess: "AGENT_ONLY" }];
    if (url.endsWith("/agents/listings/details/agent-docs-bounty")) return AGENT_LISTING;
    if (url.endsWith("/agents/listings/details/human-one")) return { ...AGENT_LISTING, slug: "human-one", agentAccess: "HUMAN_ONLY" };
    if (url.endsWith("/agents/submissions/create"))
      return opts.duplicate ? jsonResponse({ error: "Submission already exists" }, 400) : { id: "sub1" };
    if (url.endsWith("/agents/submissions/update")) return { id: "sub1" };
    return jsonResponse("?", 500);
  });
}

describe("superteam-earn agent API", () => {
  const CREDS = { SUPERTEAM_AGENT_KEY: "sk_test", SUPERTEAM_CLAIM_CODE: "CLAIM1" };

  it("registers an agent and hands back the key and the claim link", async () => {
    const names: string[] = [];
    const api = agentApi([]);
    const fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/agents") && init?.method === "POST") names.push(JSON.parse(String(init.body)).name);
      return api(url, init);
    }) as typeof globalThis.fetch;
    const reg = await superteamEarn.register!({ email: "team@example.com", handle: "kariaa-agent" }, testContext({ fetch }));
    expect(names[0]).toMatch(/^kariaa-agent-[0-9a-f]{6}$/u);
    await superteamEarn.register!({ email: "private.person@example.com" }, testContext({ fetch }));
    expect(names[1]).toMatch(/^Kariaa agent-[0-9a-f]{6}$/u); // never from the email
    expect(reg.credentials).toEqual({ SUPERTEAM_AGENT_KEY: "sk_new", SUPERTEAM_CLAIM_CODE: "CLAIM1" });
    expect(reg.account_id).toBe("kariaa-agent");
    expect(reg.next_step).toContain("https://superteam.fun/earn/claim/CLAIM1");
  });

  it("searches the agent listings with a key and asks the questions in order", async () => {
    const ctx = testContext({ fetch: agentApi([]), credentials: CREDS });
    const { jobs } = await superteamEarn.search!({}, ctx);
    expect(jobs.map((j) => j.id)).toEqual(["agent-docs-bounty", "agent-only", "public-one"]);
    expect(jobs[0]!.requirements?.questions).toEqual([
      { id: "q1", question: "Link to the docs PR", type: "text", required: true },
      { id: "q2", question: "Anything else?", type: "text", required: false },
    ]);
    expect(await superteamEarn.account!(ctx)).toMatchObject({
      signed_in: true,
      profile: { claim_url: "https://superteam.fun/earn/claim/CLAIM1" },
    });
  });

  it("submits the work, edits on a second submit, and refuses what it can't send", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ctx = testContext({ fetch: agentApi(calls), credentials: CREDS });
    await expect(superteamEarn.apply!("agent-docs-bounty", { note: "x" }, testContext({ fetch: agentApi([]) }))).rejects.toMatchObject({
      code: "auth_required",
    });
    await expect(superteamEarn.apply!("agent-docs-bounty", { note: "Docs" }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("q1"),
    });
    await expect(superteamEarn.apply!("human-one", { note: "x" }, ctx)).rejects.toMatchObject({ code: "forbidden" });
    const app = await superteamEarn.apply!(
      "agent-docs-bounty",
      { answers: { link: "https://github.com/o/r/pull/1", q1: "https://github.com/o/r/pull/1" }, note: "Wrote the SDK docs." },
      ctx,
    );
    const post = calls.find((c) => c.url.endsWith("/submissions/create"))!;
    expect(JSON.parse(String(post.init!.body))).toEqual({
      listingId: AGENT_LISTING.id,
      link: "https://github.com/o/r/pull/1",
      tweet: "",
      otherInfo: "Wrote the SDK docs.",
      eligibilityAnswers: [
        { question: "Link to the docs PR", answer: "https://github.com/o/r/pull/1" },
        { question: "Anything else?", answer: "" },
      ],
      ask: null,
    });
    expect(app).toMatchObject({ id: "agent-docs-bounty", stage: "in_review" });
    expect(app.next).toContain("2026-11-20");
    expect(app.next).toContain("earn/claim/CLAIM1");

    const again: { url: string; init?: RequestInit }[] = [];
    const edited = await superteamEarn.apply!(
      "agent-docs-bounty",
      { answers: { link: "https://x.dev", q1: "https://x.dev" } },
      testContext({ fetch: agentApi(again, { duplicate: true }), credentials: CREDS }),
    );
    expect(again.some((c) => c.url.endsWith("/submissions/update"))).toBe(true);
    expect(edited.next).toContain("Submission updated.");

    expect(await superteamEarn.status!("agent-docs-bounty", ctx)).toMatchObject({ stage: "in_review" });
  });
});
