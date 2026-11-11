import { describe, expect, it } from "vitest";
import { defineConnector, type Connector } from "../src/core/connector.js";
import { spread, WorkProtocol } from "../src/core/router.js";
import type { ConnectorCategory, Job, NativeJob, PayoutRail } from "../src/core/types.js";
import { indexable, indexCatalog } from "../src/search/indexer.js";
import { LocalIndex } from "../src/search/localIndex.js";
import { extractSkills, payUsd, toIndexRow } from "../src/search/normalize.js";
import { understand } from "../src/search/understand.js";

const NOW = Date.parse("2026-10-28T12:00:00Z");

type Source = { id: string; category: ConnectorCategory; rails: PayoutRail[]; jobs: NativeJob[] };

/** A small corpus shaped like the catalog platforms' listings. */
const SOURCES: Source[] = [
  {
    id: "algora",
    category: "bounty",
    rails: ["fiat"],
    jobs: [
      {
        id: "a1",
        kind: "task",
        title: "Fix flaky Python test in the CLI",
        org: "acme/cli",
        tags: ["python", "testing"],
        pay: { min: 300, max: 300, currency: "USD" },
        url: "https://algora.io/a1",
      },
      {
        id: "a2",
        kind: "task",
        title: "Add dark mode to the React dashboard",
        org: "acme/web",
        tags: ["react", "typescript"],
        pay: { min: 150, max: 150, currency: "USD" },
        url: "https://algora.io/a2",
      },
      {
        id: "a3",
        kind: "task",
        title: "Rust: speed up the parser",
        org: "fastlib",
        tags: ["rust", "performance"],
        pay: { min: 800, max: 800, currency: "USD" },
        url: "https://algora.io/a3",
      },
    ],
  },
  {
    id: "moltjobs",
    category: "bounty",
    rails: ["crypto"],
    jobs: [
      {
        id: "m1",
        kind: "task",
        title: "Summarise 20 research papers on LLM evaluation",
        summary: "Write a one-paragraph summary per paper.",
        pay: { min: 40, max: 40, currency: "USDC" },
        url: "https://moltjobs.example/m1",
      },
      {
        id: "m2",
        kind: "task",
        title: "Scrape and clean a product catalogue to JSON",
        summary: "Python or Node, output JSON lines.",
        pay: { min: 25, max: 25, currency: "USDC" },
        url: "https://moltjobs.example/m2",
      },
      {
        id: "m3",
        kind: "task",
        title: "Translate app strings English to Spanish",
        pay: { min: 15, max: 15, currency: "USDC" },
        url: "https://moltjobs.example/m3",
      },
    ],
  },
  {
    id: "kaggle",
    category: "competition",
    rails: ["fiat"],
    jobs: [
      {
        id: "k1",
        kind: "task",
        title: "Forecast store sales with time series",
        org: "Kaggle",
        tags: ["forecasting", "tabular"],
        pay: { min: 25000, max: 25000, currency: "USD" },
        url: "https://kaggle.com/c/k1",
      },
      {
        id: "k2",
        kind: "task",
        title: "Image segmentation of satellite photos",
        org: "Kaggle",
        tags: ["computer vision"],
        pay: { min: 50000, max: 50000, currency: "USD" },
        url: "https://kaggle.com/c/k2",
      },
      {
        id: "k3",
        kind: "task",
        title: "Playground: predict house prices",
        org: "Kaggle",
        tags: ["tabular", "beginner"],
        url: "https://kaggle.com/c/k3",
      },
    ],
  },
  {
    id: "hackerone",
    category: "bounty",
    rails: ["fiat", "crypto"],
    jobs: [
      {
        id: "h1",
        kind: "task",
        title: "Acme bug bounty program",
        summary: "Find vulnerabilities: XSS, SSRF, auth bypass.",
        pay: { max: 10000, currency: "USD" },
        url: "https://hackerone.com/acme",
      },
      {
        id: "h2",
        kind: "task",
        title: "Wallet app security program",
        summary: "Smart contract and mobile app vulnerabilities.",
        pay: { max: 50000, currency: "USD" },
        url: "https://hackerone.com/wallet",
      },
    ],
  },
  {
    id: "whop-bounties",
    category: "micro_task",
    rails: ["fiat"],
    jobs: [
      {
        id: "w1",
        kind: "task",
        title: "Clip our podcast into TikTok shorts",
        summary: "Video editing, 30-60 s clips.",
        pay: { min: 2, max: 2, currency: "USD", period: "unit", unit: "per 1k views" },
        url: "https://whop.com/w1",
      },
      {
        id: "w2",
        kind: "task",
        title: "UGC review video of our skincare product",
        pay: { min: 50, max: 50, currency: "USD", period: "unit" },
        url: "https://whop.com/w2",
      },
    ],
  },
  {
    id: "topcoder",
    category: "competition",
    rails: ["fiat"],
    jobs: [
      {
        id: "t1",
        kind: "task",
        title: "Design challenge: mobile banking UI in Figma",
        tags: ["design", "figma"],
        pay: { min: 1200, max: 1200, currency: "USD" },
        url: "https://topcoder.com/t1",
      },
      {
        id: "t2",
        kind: "task",
        title: "Develop a Node.js API for invoices",
        tags: ["javascript", "api"],
        pay: { min: 900, max: 900, currency: "USD" },
        url: "https://topcoder.com/t2",
      },
    ],
  },
  {
    id: "opentask",
    category: "bounty",
    rails: ["crypto"],
    jobs: [
      {
        id: "o1",
        kind: "task",
        title: "Write a Solidity audit report for an ERC-20",
        tags: ["solidity", "security"],
        pay: { min: 500, max: 500, currency: "USDC" },
        url: "https://opentask.example/o1",
      },
      {
        id: "o2",
        kind: "task",
        title: "Label 500 images of street signs",
        tags: ["data labeling"],
        pay: { min: 30, max: 30, currency: "USDC" },
        url: "https://opentask.example/o2",
      },
    ],
  },
];

function connectorOf(source: Source, extra: Partial<Connector> = {}): Connector {
  return defineConnector({
    id: source.id,
    name: source.id,
    description: "Test source.",
    kinds: ["task"],
    category: source.category,
    payoutRails: source.rails,
    tier: "self",
    auth: { type: "none" },
    async search(query) {
      const words = (query.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
      const jobs = source.jobs.filter((j) =>
        words.every((w) => `${j.title} ${j.summary ?? ""} ${(j.tags ?? []).join(" ")}`.toLowerCase().includes(w)),
      );
      return { jobs };
    },
    ...extra,
  });
}

async function builtIndex(): Promise<{ index: LocalIndex; protocol: WorkProtocol }> {
  const protocol = new WorkProtocol({ connectors: SOURCES.map((s) => connectorOf(s)), env: {}, cache: null });
  const index = new LocalIndex({ now: () => NOW });
  await indexCatalog({ protocol, store: index, now: () => NOW });
  return { index, protocol };
}

describe("understand", () => {
  it("takes filters out of the words", () => {
    expect(understand("python bounty over $200 paid in USD, remote")).toMatchObject({
      core: "python",
      categories: ["bounty"],
      minPayUsd: 200,
      fiatOnly: true,
      remoteOnly: true,
    });
    expect(understand("ML competition $1k+")).toMatchObject({ categories: ["competition"], minPayUsd: 1000 });
    expect(understand("ML competition $1k+").text).toContain("machine learning");
    expect(understand("data labeling tasks for agents")).toMatchObject({ categories: ["micro_task"], forAgents: true });
    expect(understand("smart contract audit paid in crypto")).toMatchObject({ core: "smart contract audit", cryptoOnly: true });
    expect(understand("smart contracts").categories).toBeUndefined();
    expect(understand("")).toEqual({ text: "", core: "" });
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(understand("python bounties this month", now)).toMatchObject({ core: "python", postedAfter: "2026-10-01" });
    expect(understand("new this week", now)).toMatchObject({ core: "", postedAfter: "2026-10-23" });
    expect(understand("this month, posted today", now).postedAfter).toBe("2026-10-30");
  });
});

describe("normalize", () => {
  const job = (extra: Partial<Job>): Job => ({ id: "x:1", connector: "x", kind: "task", title: "t", stages: ["get"], ...extra });

  it("converts pay to USD and knows when it can't", () => {
    expect(payUsd(job({ pay: { max: 100, currency: "EUR" } }), { EUR: 1.1 })).toBe(110);
    expect(payUsd(job({ pay: { min: 40, currency: "USDC" } }), { USDC: 1 })).toBe(40);
    expect(payUsd(job({ pay: { min: 40, currency: "ZZZ" } }), {})).toBeUndefined();
    expect(payUsd(job({}), {})).toBeUndefined();
  });

  it("reads skills, payout rails and a stable hash", () => {
    const j = job({ title: "Fix flaky Python test", tags: ["react"], description: "Solidity too" });
    expect(extractSkills(j)).toEqual(["python", "react", "solidity"]);
    const row = toIndexRow(j, { category: "bounty", payoutRails: ["fiat"] });
    expect(row).toMatchObject({ fiat: true, category: "bounty", dedupe_key: "|fixflakypythontest" });
    expect(toIndexRow(j, {}).content_hash).toBe(row.content_hash);
    expect(toIndexRow({ ...j, title: "Changed" }, {}).content_hash).not.toBe(row.content_hash);
  });
});

describe("search quality (golden queries)", () => {
  const GOLDEN: [string, string[]][] = [
    ["python bounty", ["algora:a1"]],
    ["python bounties paid in USD", ["algora:a1"]],
    ["react", ["algora:a2"]],
    ["rust performance", ["algora:a3"]],
    ["forecasting competition", ["kaggle:k1"]],
    ["computer vision", ["kaggle:k2"]],
    ["security vulnerabilities", ["hackerone:h1", "hackerone:h2"]],
    ["smart contract audit", ["opentask:o1"]],
    ["video clips", ["whop-bounties:w1"]],
    ["figma design challenge", ["topcoder:t1"]],
    ["node.js api", ["topcoder:t2"]],
    ["summarise research papers", ["moltjobs:m1"]],
    ["translation spanish", ["moltjobs:m3"]],
    ["image labeling", ["opentask:o2"]],
    ["javascript", ["topcoder:t2"]],
  ];

  it.each(GOLDEN)("%s finds the right listing in the top 3", async (q, expected) => {
    const { protocol, index } = await builtIndex();
    const search = new WorkProtocol({ registry: protocol.registry, env: {}, cache: null, index });
    const top = (await search.search({ query: q, limit: 3 })).jobs.map((j) => j.id);
    for (const id of expected.slice(0, 1)) expect(top).toContain(id);
  });

  it("applies pay, payout and category filters", async () => {
    const { protocol, index } = await builtIndex();
    const search = new WorkProtocol({ registry: protocol.registry, env: {}, cache: null, index });
    const big = (await search.search({ query: "competition over $30k" })).jobs.map((j) => j.id);
    expect(big).toEqual(["kaggle:k2"]);
    const fiat = (await search.search({ query: "bounty paid in USD", limit: 20 })).jobs;
    expect(fiat.length).toBeGreaterThan(0);
    expect(fiat.every((j) => ["algora", "hackerone"].includes(j.connector))).toBe(true);
    const crypto = (await search.search({ query: "tasks paid in crypto", limit: 20 })).jobs;
    expect(crypto.every((j) => ["moltjobs", "opentask", "hackerone"].includes(j.connector))).toBe(true);
  });
});

describe("router with an index", () => {
  it("answers covered platforms from the index and asks the rest live", async () => {
    const { protocol, index } = await builtIndex();
    const asked: string[] = [];
    const upwork = defineConnector({
      id: "upwork",
      name: "Upwork",
      description: "Test.",
      kinds: ["task"],
      category: "job",
      payoutRails: ["fiat"],
      tier: "self",
      auth: { type: "none" },
      async search(query) {
        asked.push(query.query ?? "");
        return { jobs: [{ id: "u1", kind: "task", title: "Python data pipeline contract", url: "https://upwork.com/u1" }] };
      },
    });
    const covered = SOURCES.map((s) =>
      connectorOf(s, {
        async search() {
          asked.push(`live:${s.id}`);
          return { jobs: [] };
        },
      }),
    );
    const search = new WorkProtocol({ connectors: [...covered, upwork], env: {}, cache: null, index });
    void protocol;
    // limit 2: one index hit is not a thin answer, so covered platforms stay off the live path.
    const result = await search.search({ query: "python bounty", limit: 2 });
    expect(result.jobs.map((j) => j.id)).toEqual(expect.arrayContaining(["algora:a1", "upwork:u1"]));
    // Only Upwork went live, with the words and without the filter word.
    expect(asked).toEqual(["python"]);
  });

  it("also asks covered platforms live when the index answer is thin", async () => {
    const { index } = await builtIndex();
    const asked: string[] = [];
    const covered = SOURCES.map((s) =>
      connectorOf(s, {
        async search(query) {
          asked.push(s.id);
          return {
            jobs:
              s.id === "kaggle"
                ? [{ id: "k9", kind: "task" as const, title: `Kaggle ${query.query}`, url: "https://kaggle.com/c/k9" }]
                : [],
          };
        },
      }),
    );
    const search = new WorkProtocol({ connectors: covered, env: {}, cache: null, index });
    const result = await search.search({ query: "quantum chemistry", limit: 10 });
    expect(asked).toContain("kaggle");
    expect(result.jobs.map((j) => j.id)).toContain("kaggle:k9");
  });

  it("falls back to live search when the index fails, and pages with a cursor", async () => {
    const { index } = await builtIndex();
    const broken = Object.assign(Object.create(index) as LocalIndex, {
      search: async () => {
        throw new Error("db down");
      },
    });
    const live = new WorkProtocol({ connectors: SOURCES.map((s) => connectorOf(s)), env: {}, cache: null, index: broken });
    expect((await live.search({ query: "rust" })).jobs.map((j) => j.id)).toEqual(["algora:a3"]);

    const paged = new WorkProtocol({ connectors: SOURCES.map((s) => connectorOf(s)), env: {}, cache: null, index });
    const first = await paged.search({ query: "", limit: 3 });
    expect(first.cursor).toBeTruthy();
    const second = await paged.search({ query: "", limit: 3, cursor: first.cursor! });
    const firstIds = new Set(first.jobs.map((j) => j.id));
    expect(second.jobs.length).toBeGreaterThan(0);
    expect(second.jobs.some((j) => firstIds.has(j.id))).toBe(false);
    await expect(paged.search({ cursor: "!!" })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("indexer", () => {
  it("indexes public catalog sources only, embeds what changed, and closes what went away", async () => {
    const selling = defineConnector({ ...connectorOf(SOURCES[0]!), id: "shopify", category: "selling" });
    const personal = defineConnector({
      ...connectorOf(SOURCES[0]!),
      id: "upwork",
      auth: { type: "oauth", help: "sign in", required: true },
    });
    const untrusted = defineConnector({ ...connectorOf(SOURCES[0]!), id: "remotive", tier: undefined });
    let jobs = SOURCES[1]!.jobs;
    const molt = connectorOf(SOURCES[1]!, {
      async search() {
        return { jobs };
      },
    });
    const protocol = new WorkProtocol({ connectors: [molt, selling, personal, untrusted], env: {}, cache: null });
    let clock = NOW;
    const index = new LocalIndex({ now: () => clock });
    const embedded: string[][] = [];
    const embedder = async (texts: string[]) => {
      embedded.push(texts);
      return texts.map(() => [1, 0, 0]);
    };

    const first = await indexCatalog({ protocol, store: index, embedder, now: () => clock });
    expect(first.map((r) => r.connector)).toEqual(["moltjobs"]);
    expect(first[0]).toMatchObject({ seen: 3, changed: 3, closed: 0 });

    clock += 3_600_000;
    const again = await indexCatalog({ protocol, store: index, embedder, now: () => clock });
    expect(again[0]).toMatchObject({ seen: 3, changed: 0 });
    expect(embedded).toHaveLength(1);

    jobs = jobs.slice(0, 2);
    clock += 25 * 3_600_000;
    const later = await indexCatalog({ protocol, store: index, embedder, now: () => clock });
    expect(later[0]).toMatchObject({ seen: 2, closed: 1 });
    expect(index.size).toBe(2);

    // A run that sees nothing (an outage) closes nothing.
    jobs = [];
    clock += 25 * 3_600_000;
    expect((await indexCatalog({ protocol, store: index, now: () => clock }))[0]).toMatchObject({ seen: 0, closed: 0 });
    expect(index.size).toBe(2);
  });
});

describe("posted_after", () => {
  it("keeps work posted since the date, and undated work only while a closing date is ahead", async () => {
    const jobs: NativeJob[] = [
      { id: "new", kind: "task", title: "New task", url: "https://x.example/new", posted_at: "2026-10-12T00:00:00Z" },
      { id: "old", kind: "task", title: "Old task", url: "https://x.example/old", posted_at: "2026-08-02T00:00:00Z" },
      { id: "open", kind: "task", title: "Ongoing task", url: "https://x.example/open", expires_at: "2099-01-01" },
      { id: "closed", kind: "task", title: "Closed task", url: "https://x.example/closed", expires_at: "2026-09-01" },
      { id: "evergreen", kind: "task", title: "Evergreen task", url: "https://x.example/ever" },
    ];
    const source = defineConnector({
      id: "dated",
      name: "Dated",
      description: "Tasks with dates.",
      kinds: ["task"],
      auth: { type: "none" },
      async search() {
        return { jobs };
      },
    });
    const p = new WorkProtocol({ connectors: [source], env: {}, cache: null });
    const ids = async (q: Parameters<WorkProtocol["search"]>[0]) => (await p.search(q)).jobs.map((j) => j.id).sort();
    expect(await ids({ connectors: ["dated"], posted_after: "2026-10-01" })).toEqual(["dated:new", "dated:open"]);
    expect(await ids({ connectors: ["dated"] })).toHaveLength(5);
  });
});

describe("a fair page", () => {
  const item = (connector: string, n: number) => ({ job: { connector, id: `${connector}:${n}` } });

  it("keeps one platform to a third of the page while others have results, then fills from the rest", () => {
    const ranked = [...Array.from({ length: 30 }, (_, i) => item("remotive", i)), item("near", 1), item("opentask", 1), item("kaggle", 1)];
    const page = spread(ranked, 12);
    expect(page.filter((x) => x.job.connector === "remotive")).toHaveLength(9); // 4 by the cap, 5 to fill
    expect(page.slice(0, 7).map((x) => x.job.connector)).toEqual([
      "remotive",
      "remotive",
      "remotive",
      "remotive",
      "near",
      "opentask",
      "kaggle",
    ]);
    expect(spread(ranked, 12, true).every((x) => x.job.connector === "remotive")).toBe(true);
  });

  it("ranks platforms where the agent acts above find-only ones, all else equal", async () => {
    const job = (id: string): NativeJob => ({ id, kind: "task", title: "Write a Python CSV parser", url: `https://x.example/${id}` });
    const of = (id: string, tier: "self" | "discover") =>
      defineConnector({
        id,
        name: id,
        description: "Test.",
        kinds: ["task"],
        tier,
        auth: { type: "none" },
        async search() {
          return { jobs: [job(`${id}-1`)] };
        },
      });
    const p = new WorkProtocol({ connectors: [of("findonly", "discover"), of("doable", "self")], env: {}, cache: null });
    expect((await p.search({ query: "python csv" })).jobs.map((j) => j.connector)).toEqual(["doable", "findonly"]);
  });
});

describe("index for named platforms and dates", () => {
  it("answers a named, indexed platform from the index", async () => {
    const { index } = await builtIndex();
    const asked: string[] = [];
    const live = SOURCES.map((s) =>
      connectorOf(s, {
        async search() {
          asked.push(s.id);
          return { jobs: [] };
        },
      }),
    );
    const p = new WorkProtocol({ connectors: live, env: {}, cache: null, index });
    const r = await p.search({ connectors: ["algora"] });
    expect(r.jobs.map((j) => j.id)).toContain("algora:a1");
    expect(asked).toEqual([]);
  });

  it("filters the local index by posting date", async () => {
    const { index } = await builtIndex();
    const all = await index.search({ text: "", limit: 50, offset: 0 });
    const recent = await index.search({ text: "", postedAfter: "2999-01-01", limit: 50, offset: 0 });
    expect(all.length).toBeGreaterThan(0);
    expect(recent.every((h) => !h.job.posted_at && Boolean(h.job.expires_at))).toBe(true);
  });
});

describe("a full page from live sources", () => {
  it("asks a live source for more than the page, so duplicates don't thin it", async () => {
    let asked = 0;
    const source = defineConnector({
      id: "dupes",
      name: "Dupes",
      description: "Test.",
      kinds: ["task"],
      tier: "self",
      auth: { type: "none" },
      async search(query) {
        asked = query.limit ?? 0;
        const jobs: NativeJob[] = [
          { id: "1", kind: "task", title: "Same offer", org: "A", url: "https://d.example/1" },
          { id: "2", kind: "task", title: "Same offer", org: "A", url: "https://d.example/1" },
          { id: "3", kind: "task", title: "Second", url: "https://d.example/3" },
          { id: "4", kind: "task", title: "Third", url: "https://d.example/4" },
          { id: "5", kind: "task", title: "Fourth", url: "https://d.example/5" },
          { id: "6", kind: "task", title: "Fifth", url: "https://d.example/6" },
        ];
        return { jobs: jobs.slice(0, query.limit ?? 20) };
      },
    });
    const p = new WorkProtocol({ connectors: [source], env: {}, cache: null });
    const r = await p.search({ connectors: ["dupes"], limit: 3 });
    expect(asked).toBe(6);
    expect(r.jobs).toHaveLength(3);
  });
});

describe("closed listings leave the index", () => {
  it("marks a listing closed as soon as get_job finds it gone", async () => {
    const { index } = await builtIndex();
    const gone = SOURCES.map((s) =>
      connectorOf(s, {
        async get() {
          return null;
        },
      }),
    );
    const p = new WorkProtocol({ connectors: gone, env: {}, cache: null, index });
    expect((await p.search({ connectors: ["algora"] })).jobs.map((j) => j.id)).toContain("algora:a1");
    await expect(p.get("algora:a1")).rejects.toMatchObject({ code: "not_found" });
    await new Promise((r) => setTimeout(r, 0));
    expect((await p.search({ connectors: ["algora"] })).jobs.map((j) => j.id)).not.toContain("algora:a1");
  });
});

describe("index refresh", () => {
  it("closes what a complete run didn't see right away, and waits on a partial run", async () => {
    let now = NOW;
    let jobs: NativeJob[] = [1, 2, 3].map((n) => ({ id: `t${n}`, kind: "task", title: `Task ${n}`, url: `https://s.example/${n}` }));
    let more = false;
    const source = defineConnector({
      id: "small",
      name: "Small",
      description: "Test.",
      kinds: ["task"],
      tier: "self",
      auth: { type: "none" },
      async search() {
        return { jobs, more };
      },
    });
    const protocol = new WorkProtocol({ connectors: [source], env: {}, cache: null });
    const index = new LocalIndex({ now: () => now });
    await indexCatalog({ protocol, store: index, now: () => now });
    const open = async () => (await index.search({ text: "", limit: 50, offset: 0 })).map((h) => h.job.id).sort();
    expect(await open()).toEqual(["small:t1", "small:t2", "small:t3"]);

    now += 60_000;
    jobs = jobs.slice(0, 2);
    const [complete] = await indexCatalog({ protocol, store: index, now: () => now });
    expect(complete).toMatchObject({ seen: 2, closed: 1 });
    expect(await open()).toEqual(["small:t1", "small:t2"]);

    now += 60_000;
    jobs = jobs.slice(0, 1);
    more = true; // the platform says there is more: this run may have missed t2
    const [partial] = await indexCatalog({ protocol, store: index, now: () => now });
    expect(partial).toMatchObject({ closed: 0 });
    expect(await open()).toEqual(["small:t1", "small:t2"]);
  });
});

describe("what the indexer reads", () => {
  it("indexes a platform that needs a key only when the server holds one", () => {
    const keyed = defineConnector({
      id: "keyed",
      name: "Keyed",
      description: "Test.",
      kinds: ["task"],
      tier: "self",
      auth: { type: "api_key", env: ["KEYED_TOKEN"], help: "token", required: true },
      async search() {
        return { jobs: [] };
      },
    });
    const info = (env: Record<string, string>) => new WorkProtocol({ connectors: [keyed], env, cache: null }).connectors()[0]!;
    expect(indexable(info({}))).toBe(false);
    expect(indexable(info({ KEYED_TOKEN: "server-read-key" }))).toBe(true);
  });
});

describe("embedding backfill", () => {
  it("embeds rows indexed before an embedder was set, once", async () => {
    const { index, protocol } = await builtIndex(); // built without an embedder
    const embedded: string[] = [];
    const embedder = async (texts: string[]) => {
      embedded.push(...texts);
      return texts.map(() => [0.1, 0.2]);
    };
    await indexCatalog({ protocol, store: index, now: () => NOW, embedder });
    const first = embedded.length;
    expect(first).toBeGreaterThan(0);
    expect(await index.unembedded([...(await index.hashes(["algora:a1"])).keys()])).toEqual(new Set());
    await indexCatalog({ protocol, store: index, now: () => NOW, embedder });
    expect(embedded.length).toBe(first); // nothing left to embed
  });
});
