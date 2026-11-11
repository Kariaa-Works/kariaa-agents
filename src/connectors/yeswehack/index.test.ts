import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, jsonResponse, testContext, type RecordedCall } from "../../core/conformance.js";
import { YESWEHACK_API, programToJob, yeswehack } from "./index.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;
const programs = load("programs.json");
const program = load("program.json");

function api(calls: RecordedCall[] = []) {
  return fixtureFetch((url, init) => {
    calls.push({ url, init });
    if (url === `${YESWEHACK_API}/programs?page=1&resultsPerPage=100`) return programs;
    if (url === `${YESWEHACK_API}/programs/superbank-public-bug-bounty-program`) return program;
    if (url === `${YESWEHACK_API}/programs/a-private-program`) return jsonResponse({ code: 403, message: "Access Denied." }, 403);
    if (url.startsWith(`${YESWEHACK_API}/programs/`)) return jsonResponse({ code: 404, message: "Not Found" }, 404);
    return jsonResponse("?", 500);
  });
}

describeConnectorConformance(yeswehack, { search: { query: "bank" }, fetch: api(), expectQueryInUrl: false });

describe("yeswehack", () => {
  it("maps the program list: bounty ranges, gifts, disclosure programs and audiences", async () => {
    const calls: RecordedCall[] = [];
    const { jobs, more } = await yeswehack.search!({}, testContext({ fetch: api(calls) }));
    expect(calls.map((c) => c.url)).toEqual([`${YESWEHACK_API}/programs?page=1&resultsPerPage=100`]);
    expect(more).toBe(false);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      id: "superbank-public-bug-bounty-program",
      kind: "task",
      title: "Superbank - Public Bug Bounty Program",
      org: "Superbank",
      location: { remote: true },
      pay: {
        max: 2000,
        currency: "USD",
        period: "unit",
        unit: "per valid report",
        text: "up to 2,000 USD per valid report, by severity and asset value",
      },
      summary: "Superbank is digital bank from Indonesia.",
      url: "https://yeswehack.com/programs/superbank-public-bug-bounty-program",
      tags: ["bug-bounty", "bounty", "finance-assurance", "source:yeswehack"],
      raw: { country: "ID", scopes_count: 6, reports_count: 132, report_submission_cost: 3, last_update_at: "2026-09-14T07:51:27.000Z" },
    });
    expect(jobs[0]!.pay).not.toHaveProperty("min");
    expect(jobs[0]!.apply_hint).toContain("yeswehack.com");
    expect(jobs[1]).toMatchObject({
      id: "ovh",
      pay: { min: 50, max: 12500, currency: "EUR", text: "50–12,500 EUR per valid report, by severity and asset value, plus gifts" },
      tags: ["bug-bounty", "bounty", "gift", "tech-other", "source:yeswehack"],
    });
    expect(jobs[2]).toMatchObject({
      id: "govtech-vulnerability-disclosure-programme-policy",
      org: "Government Technology Agency of Singapore",
      pay: { text: "No bounty: vulnerability disclosure program." },
      tags: ["bug-bounty", "vdp", "vdp-in-app", "verified-hunters", "government", "source:yeswehack"],
      requirements: { rules: ["Open to verified hunters only."] },
    });
  });

  it("filters words here, caches the list and respects the limit", async () => {
    const calls: RecordedCall[] = [];
    const ctx = testContext({ fetch: api(calls) });
    expect((await yeswehack.search!({ query: "bank" }, ctx)).jobs.map((j) => j.id)).toEqual(["superbank-public-bug-bounty-program"]);
    expect((await yeswehack.search!({ query: "singapore" }, ctx)).jobs.map((j) => j.id)).toEqual([
      "govtech-vulnerability-disclosure-programme-policy",
    ]);
    const one = await yeswehack.search!({ limit: 1 }, ctx);
    expect(one).toMatchObject({ more: true });
    expect(one.jobs).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("pages through a longer list", async () => {
    const urls: string[] = [];
    const row = (n: number) => ({
      title: `Program ${n}`,
      slug: `program-${n}`,
      bounty: true,
      bounty_reward_max: 100,
      business_unit: { name: "Co", currency: "EUR" },
    });
    const fetch = fixtureFetch((url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return {
        pagination: { page, nb_pages: 2, results_per_page: 100, nb_results: 150 },
        items: Array.from({ length: page === 1 ? 100 : 50 }, (_, i) => row((page - 1) * 100 + i)),
      };
    });
    const { jobs, more } = await yeswehack.search!({ limit: 50 }, testContext({ fetch }));
    expect(urls).toEqual([`${YESWEHACK_API}/programs?page=1&resultsPerPage=100`, `${YESWEHACK_API}/programs?page=2&resultsPerPage=100`]);
    expect(jobs).toHaveLength(50);
    expect(more).toBe(true);
  });

  it("reads one program with its rules, scopes, what qualifies and the reward grid", async () => {
    const job = await yeswehack.get!("superbank-public-bug-bounty-program", testContext({ fetch: api() }));
    expect(job).toMatchObject({
      id: "superbank-public-bug-bounty-program",
      org: "Superbank",
      summary: "Superbank is digital bank from Indonesia.",
    });
    expect(job!.description).toContain("## Superbank");
    expect(job!.description).toContain(
      "Scopes:\n- https://apps.apple.com/id/app/superbank/id6444720285 (Mobile application IOS, asset value high)\n- https://play.google.com/store/apps/details?id=id.co.bankfama.android&hl=en (Mobile application Android, asset value high)\n- api.super-id.net (API, asset value high)",
    );
    expect(job!.description).toContain(
      "Out of scope:\n- Applications, URLs, or data that are not listed on this page are considered out of scope.",
    );
    expect(job!.description).toContain("Qualifying vulnerabilities:\n- SQL Injection (SQLi)\n- Cross-Site Scripting (XSS)");
    expect(job!.description).toContain("Account access:\n## Self-register");
    expect(job!.raw).toMatchObject({
      scopes: [
        { scope: "https://apps.apple.com/id/app/superbank/id6444720285", type: "Mobile application IOS", asset_value: "HIGH" },
        {
          scope: "https://play.google.com/store/apps/details?id=id.co.bankfama.android&hl=en",
          type: "Mobile application Android",
          asset_value: "HIGH",
        },
        { scope: "api.super-id.net", type: "API", asset_value: "HIGH" },
      ],
      reward_grid: {
        medium: { low: 100, medium: 300, high: 800, critical: 1000 },
        high: { low: 150, medium: 400, high: 1000, critical: 2000 },
      },
    });
  });

  it("answers not_found for missing and private programs, and null for ids that cannot be slugs", async () => {
    const ctx = testContext({ fetch: api() });
    await expect(yeswehack.get!("no-such-program", ctx)).rejects.toMatchObject({ code: "not_found" });
    await expect(yeswehack.get!("a-private-program", ctx)).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("private"),
    });
    expect(await yeswehack.get!("not a slug", ctx)).toBeNull();
  });

  it("returns archived or disabled programs find-only", () => {
    expect(programToJob({ title: "Old", slug: "old", archived: true, bounty: false })).toMatchObject({
      stages: ["search", "get"],
      apply_hint: "This program is archived; it takes no reports.",
      tags: ["bug-bounty", "vdp", "archived", "source:yeswehack"],
    });
    expect(programToJob({ title: "No slug" })).toBeNull();
  });
});
