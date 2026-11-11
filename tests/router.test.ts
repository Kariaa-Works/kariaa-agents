import { describe, expect, it } from "vitest";
import { defineConnector } from "../src/core/connector.js";
import { ProtocolError } from "../src/core/errors.js";
import { JobCache } from "../src/core/jobCache.js";
import { applyFilters } from "../src/core/jsonBoard.js";
import { WorkProtocol, dedupeKey, scoreJob } from "../src/core/router.js";
import type { NativeJob } from "../src/core/types.js";
import { fullStageConnector, hangingConnector, keyedConnector, searchOnlyConnector, throwingConnector } from "./helpers/fakeConnectors.js";

function protocolWith(...extra: ConstructorParameters<typeof WorkProtocol>[0][]) {
  return new WorkProtocol({
    connectors: [fullStageConnector(), searchOnlyConnector(), throwingConnector(), keyedConnector()],
    env: {},
    cache: new JobCache(),
    searchTimeoutMs: 300,
    ...Object.assign({}, ...extra),
  });
}

describe("WorkProtocol.search", () => {
  it("asks only task connectors when the query is empty", async () => {
    const work = protocolWith();
    const result = await work.search({});
    expect(result.jobs.map((j) => j.id)).toEqual(["fake-tasks:t2", "fake-tasks:t1"]); // better paid first
    expect(result.partial).toEqual([]);
    expect(result.jobs[0]).toMatchObject({
      connector: "fake-tasks",
      kind: "task",
      stages: ["get", "apply", "upload", "remove", "submit", "status", "link"],
    });
  });

  it("leaves opt-in connectors out of all-source searches and asks them when named", async () => {
    const optIn = { ...searchOnlyConnector("fake-optin"), optIn: true };
    const work = protocolWith({ connectors: [searchOnlyConnector(), optIn] });
    const everywhere = await work.search({ query: "electrician" });
    expect(everywhere.jobs.length).toBeGreaterThan(0);
    expect(everywhere.jobs.map((j) => j.connector)).not.toContain("fake-optin");
    const named = await work.search({ query: "electrician", connectors: ["fake-optin"] });
    expect(named.jobs.length).toBeGreaterThan(0);
    expect([...new Set(named.jobs.map((j) => j.connector))]).toEqual(["fake-optin"]);
    expect(work.connectors().find((c) => c.id === "fake-optin")?.opt_in).toBe(true);
    expect(work.connectors().find((c) => c.id === "fake-board")?.opt_in).toBeUndefined();
  });

  it("fans out on a query, interleaves connectors, reports failures and skips unconfigured keyed sources", async () => {
    const work = protocolWith();
    const result = await work.search({ query: "electrician nurse" });
    expect(result.jobs.map((j) => j.id)).toEqual(["fake-board:l1", "fake-board:l2", "fake-board:l3"]);
    expect(result.partial).toEqual([{ connector: "fake-broken", error: { code: "upstream_error", message: "boom" } }]);
    const listing = result.jobs[0]!;
    expect(listing.stages).toEqual([]);
    expect(listing.apply_hint).toBe("Apply at https://board.example/jobs/l1?utm_source=feed");
  });

  it("includes a keyed connector once its credential is set, and reports auth when asked explicitly", async () => {
    const configured = protocolWith({ env: { FAKE_KEY: "k" } });
    const found = await configured.search({ query: "keyed" });
    expect(found.jobs.map((j) => j.id)).toContain("fake-keyed:k1");
    expect(configured.connectors().find((c) => c.id === "fake-keyed")?.auth.configured).toBe(true);

    const explicit = protocolWith();
    const asked = await explicit.search({ query: "keyed", connectors: ["fake-keyed"] });
    expect(asked.jobs).toEqual([]);
    expect(asked.partial[0]).toMatchObject({ connector: "fake-keyed", error: { code: "auth_required" } });
    expect(explicit.connectors().find((c) => c.id === "fake-keyed")?.auth).toMatchObject({
      configured: false,
      required: true,
      env: ["FAKE_KEY"],
    });
  });

  it("times out a slow connector and keeps the others", async () => {
    const work = new WorkProtocol({
      connectors: [searchOnlyConnector(), hangingConnector()],
      env: {},
      cache: new JobCache(),
      searchTimeoutMs: 100,
    });
    const started = Date.now();
    const result = await work.search({ query: "electrician" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.jobs.length).toBeGreaterThan(0);
    expect(result.partial).toEqual([
      { connector: "fake-slow", error: { code: "timeout", message: expect.stringContaining("did not answer") } },
    ]);
  });

  it("interleaves connectors round-robin, dedupes by url and caps at the limit", async () => {
    const a: NativeJob[] = [1, 2, 3].map((n) => ({ id: `a${n}`, kind: "listing", title: `A ${n}`, url: `https://x.example/${n}` }));
    const b: NativeJob[] = [1, 2, 3].map((n) => ({
      id: `b${n}`,
      kind: "listing",
      title: `B ${n}`,
      url: `https://www.x.example/${n}/?utm_source=b`,
    }));
    const work = new WorkProtocol({
      connectors: [
        searchOnlyConnector("one", a),
        searchOnlyConnector("two", b),
        searchOnlyConnector("three", [{ id: "c1", kind: "listing", title: "C 1", url: "https://c.example/1" }]),
      ],
      env: {},
      cache: new JobCache(),
    });
    const result = await work.search({ query: "", connectors: ["one", "two", "three"], limit: 3 });
    expect(result.jobs.map((j) => j.id)).toEqual(["one:a1", "three:c1", "one:a2"]);
    expect(result.more).toBe(true);
    expect(dedupeKey(result.jobs[0]!)).toBe("x.example/1");
  });

  it("validates the query and unknown connector ids", async () => {
    const work = protocolWith();
    await expect(work.search({ limit: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(work.search({ connectors: ["nope"] })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("WorkProtocol stages", () => {
  it("gets tasks live and listings from the cache", async () => {
    const work = protocolWith();
    await expect(work.get("fake-board:l1")).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("search_jobs again"),
    });
    await work.search({ query: "electrician" });
    const cached = await work.get("fake-board:l1");
    expect(cached).toMatchObject({ id: "fake-board:l1", connector: "fake-board", title: "Electrician" });
    const task = await work.get("fake-tasks:t1");
    expect(task.requirements?.questions?.[0]?.id).toBe("q1");
    await expect(work.get("fake-tasks:nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(work.get("garbage")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses unsupported stages with the apply hint", async () => {
    const work = protocolWith();
    await work.search({ query: "electrician" });
    await expect(work.apply("fake-board:l1", {})).rejects.toMatchObject({
      code: "not_supported",
      details: {
        stage: "apply",
        apply_hint: "Apply at https://board.example/jobs/l1?utm_source=feed",
        url: "https://board.example/jobs/l1?utm_source=feed",
      },
    });
    await expect(work.status("fake-board:l1")).rejects.toMatchObject({ code: "not_supported" });
  });

  it("runs apply, upload, remove, submit, status, list and link with prefixed ids", async () => {
    const work = protocolWith();
    await expect(work.apply("fake-tasks:t1", {})).rejects.toMatchObject({ code: "invalid_input", details: { question_ids: ["q1"] } });
    const application = await work.apply("fake-tasks:t1", { answers: { q1: "English" } });
    expect(application).toMatchObject({ id: "fake-tasks:a1", job_id: "fake-tasks:t1", connector: "fake-tasks", stage: "work_needed" });

    const first = await work.upload("fake-tasks:a1", {
      file: { base64: Buffer.from("ID3 some audio bytes").toString("base64"), name: "clip1.mp3" },
    });
    expect(first).toMatchObject({
      application_id: "fake-tasks:a1",
      file: { id: "f1", kind: "audio", name: "clip1.mp3" },
      progress: { received: 1, wanted: 2, ready_to_submit: false },
    });
    await expect(work.upload("fake-tasks:a1", { file: { path: "C:/nope.mp3" } })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("local paths"),
    });
    await expect(work.submit("fake-tasks:a1")).rejects.toMatchObject({ code: "not_ready" });

    const removed = await work.remove("fake-tasks:a1", "f1");
    expect(removed.removed).toEqual({ id: "f1", name: "clip1.mp3" });
    await work.upload("fake-tasks:a1", { file: { base64: Buffer.from("ID3 clip one").toString("base64"), name: "one.mp3" } });
    const second = await work.upload("fake-tasks:a1", {
      file: { base64: Buffer.from("ID3 clip two").toString("base64"), name: "two.mp3" },
    });
    expect(second.progress?.ready_to_submit).toBe(true);

    const link = await work.link("fake-tasks:a1");
    expect(link.url).toBe("https://fake.example/finish/a1");
    const submitted = await work.submit("fake-tasks:a1", { note: "done" });
    expect(submitted.stage).toBe("in_review");
    expect((await work.status("fake-tasks:a1")).stage).toBe("in_review");
    const mine = await work.list();
    expect(mine.applications.map((a) => a.id)).toEqual(["fake-tasks:a1"]);
    expect(mine.partial).toEqual([]);
    await expect(work.list("fake-board")).rejects.toMatchObject({ code: "not_supported" });
  });

  it("aggregates accounts and validates profile fields", async () => {
    const work = protocolWith();
    const accounts = await work.accounts();
    expect(accounts).toEqual([{ connector: "fake-tasks", signed_in: true, label: "fake person", ready: true, missing: [] }]);
    await expect(work.updateAccount("fake-tasks", { nope: 1 })).rejects.toMatchObject({
      code: "invalid_input",
      details: { unknown: ["nope"], allowed: ["location"] },
    });
    const updated = await work.updateAccount("fake-tasks", { location: "Accra" });
    expect(updated.profile).toEqual({ location: "Accra" });
    await expect(work.updateAccount("fake-board", {})).rejects.toMatchObject({ code: "not_supported" });
  });

  it("reports earnings and requests payouts, with ids prefixed", async () => {
    const work = protocolWith();
    const before = await work.earnings();
    expect(before.partial).toEqual([]);
    expect(before.earnings).toHaveLength(1);
    expect(before.earnings[0]).toMatchObject({
      connector: "fake-tasks",
      balance: { amount: 30, currency: "USD" },
      min_payout: { amount: 10, currency: "USD" },
      methods: ["paypal", "venmo"],
    });
    expect(before.earnings[0]!.entries?.[0]?.application_id).toBe("fake-tasks:a0");
    await expect(work.requestPayout("fake-board", { method: "paypal" })).rejects.toMatchObject({
      code: "not_supported",
      details: { stage: "payout" },
    });
    await expect(work.requestPayout("fake-tasks", { method: "cash" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(work.requestPayout("fake-tasks", { method: "paypal", amount: -1 })).rejects.toMatchObject({ code: "invalid_input" });
    const payout = await work.requestPayout("fake-tasks", { method: "paypal", destination: "ama@example.com", amount: 20 });
    expect(payout).toMatchObject({
      id: "fake-tasks:p1",
      connector: "fake-tasks",
      amount: { amount: 20, currency: "USD" },
      status: "requested",
      destination: "ama@example.com",
    });
    await expect(work.requestPayout("fake-tasks", { method: "paypal", amount: 10 })).rejects.toMatchObject({ code: "already_exists" });
    const after = await work.earnings("fake-tasks");
    expect(after.earnings[0]!.balance.amount).toBe(10);
    expect(after.earnings[0]!.payouts?.[0]?.id).toBe("fake-tasks:p1");
    await expect(work.earnings("fake-board")).rejects.toMatchObject({ code: "not_supported" });
  });

  it("closes connectors", async () => {
    const tasks = fullStageConnector();
    const work = new WorkProtocol({ connectors: [tasks], env: {}, cache: new JobCache() });
    await work.close();
    expect(tasks.flags.closed).toBe(true);
  });

  it("wraps unknown failures as upstream_error with the connector", async () => {
    const work = protocolWith();
    try {
      await work.search({ query: "x", connectors: ["fake-broken"] }).then((r) => {
        expect(r.partial[0]?.error.code).toBe("upstream_error");
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
    }
  });

  it("ranks Tier-1 direct-apply jobs with structured pay above lower-tier listings and filters by pay_min, currency, and direct_apply", async () => {
    const tier3 = searchOnlyConnector("jobicy", [
      { id: "j1", kind: "listing", title: "Software Engineer", url: "https://jobicy.example/1" },
    ]);
    const tier1 = defineConnector({
      id: "greenhouse",
      name: "Greenhouse",
      description: "ATS",
      kinds: ["listing"],
      auth: { type: "none" },
      async search() {
        return {
          jobs: [
            {
              id: "anthropic/1",
              kind: "listing",
              title: "Senior Software Engineer",
              org: "Anthropic",
              participation_mode: "direct_apply",
              pay: { min: 220000, max: 300000, currency: "USD", period: "year" },
              url: "https://boards.greenhouse.io/anthropic/jobs/1",
            },
          ],
        };
      },
      async apply(nativeId, input) {
        return {
          id: nativeId,
          job_id: nativeId,
          stage: "applied",
          raw: { answers: input.answers, note: input.note },
        };
      },
    });

    const work = new WorkProtocol({
      connectors: [tier3, tier1],
      env: {},
      cache: new JobCache(),
      candidateProfile: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: "+14155550199",
        linkedin_url: "https://linkedin.com/in/ada",
        github_url: "https://github.com/ada",
      },
    });

    const ranked = await work.search({ query: "software engineer" });
    expect(ranked.jobs[0]!.id).toBe("greenhouse:anthropic/1");
    expect(scoreJob(ranked.jobs[0]!, { query: "software engineer" })).toBeGreaterThan(
      scoreJob(ranked.jobs[1]!, { query: "software engineer" }),
    );

    const directOnly = await work.search({ query: "software engineer", direct_apply: true });
    expect(directOnly.jobs.map((j) => j.id)).toEqual(["greenhouse:anthropic/1"]);

    const highPay = await work.search({ query: "software engineer", pay_min: 200000, currency: "USD" });
    expect(highPay.jobs.map((j) => j.id)).toEqual(["greenhouse:anthropic/1"]);

    const applied = await work.apply("greenhouse:anthropic/1", { answers: { custom_q: "Yes" } });
    expect(applied.raw).toMatchObject({
      answers: expect.objectContaining({
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone: "+14155550199",
        linkedin_url: "https://linkedin.com/in/ada",
        github_url: "https://github.com/ada",
        custom_q: "Yes",
      }),
    });
  });

  it("matches partial significant tokens in applyFilters for multi-word queries", () => {
    const jobs: NativeJob[] = [
      { id: "1", kind: "listing", title: "Senior Backend TypeScript Engineer", org: "Acme" },
      { id: "2", kind: "listing", title: "Frontend Designer", org: "Beta" },
    ];
    const matched = applyFilters(jobs, { query: "senior typescript python engineer jobs" }, {});
    expect(matched.map((j) => j.id)).toEqual(["1"]);
  });
});

describe("connector categories", () => {
  const task = (id: string) => ({ id, kind: "task" as const, title: "Edit a short clip", url: `https://example.com/${id}` });
  const source = (id: string, category: "bounty" | "micro_task", payoutRails: ("fiat" | "crypto")[]) =>
    defineConnector({
      id,
      name: id,
      description: id,
      kinds: ["task"],
      category,
      payoutRails,
      auth: { type: "none" },
      async search() {
        return { jobs: [task(id)] };
      },
    });

  it("searches only the sources of the asked category", async () => {
    const work = new WorkProtocol({
      connectors: [source("clips", "micro_task", ["fiat"]), source("bugs", "bounty", ["fiat"])],
      env: {},
      cache: new JobCache(),
    });
    const clips = await work.search({ query: "clip", category: "micro_task" });
    expect(clips.jobs.map((j) => j.connector)).toEqual(["clips"]);
    expect(work.connectors().map((c) => [c.id, c.category, c.payout_rails])).toEqual([
      ["clips", "micro_task", ["fiat"]],
      ["bugs", "bounty", ["fiat"]],
    ]);
  });

  it("ranks a source that pays in ordinary currency above one that pays only on chain", async () => {
    const work = new WorkProtocol({
      connectors: [source("onchain", "micro_task", ["crypto"]), source("cash", "micro_task", ["fiat"])],
      env: {},
      cache: new JobCache(),
    });
    const result = await work.search({ query: "clip" });
    expect(result.jobs.map((j) => j.connector)).toEqual(["cash", "onchain"]);
  });
});

describe("link hint", () => {
  it("tells the agent where the person links a platform, when a connect page exists and no key is set", async () => {
    const hosted = new WorkProtocol({
      connectors: [keyedConnector()],
      env: {},
      cache: null,
      connectUrl: () => "https://kariaa.test/integrations",
    });
    const r = await hosted.search({ connectors: ["fake-keyed"] });
    expect(r.partial[0]!.error).toEqual({
      code: "auth_required",
      message: "Keyed board isn't linked for this account yet. The person links it at https://kariaa.test/integrations.",
    });
    // Locally, the connector's own help stands; with a key set, so does its refusal.
    const local = new WorkProtocol({ connectors: [keyedConnector()], env: {}, cache: null });
    expect((await local.search({ connectors: ["fake-keyed"] })).partial[0]!.error.message).toBe("Set FAKE_KEY.");
    const keyed = new WorkProtocol({
      connectors: [keyedConnector()],
      env: { FAKE_KEY: "k" },
      cache: null,
      connectUrl: () => "https://kariaa.test/integrations",
    });
    expect((await keyed.search({ connectors: ["fake-keyed"] })).partial).toEqual([]);
  });
});
