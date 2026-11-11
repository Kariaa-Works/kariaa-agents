import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, testContext } from "../../core/conformance.js";
import { immunefi } from "./index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;

// The public file holds every program and takes no query, so the query is applied to the rows.
describeConnectorConformance(immunefi, { search: { query: "bug bounty" }, fetch: fixtureFetch(fixture), expectQueryInUrl: false });

describe("immunefi", () => {
  it("maps a program: the largest reward, the token it is paid in, and where the report goes", async () => {
    const { jobs } = await immunefi.search!({}, testContext({ fetch: fixtureFetch(fixture) }));
    expect(jobs).toHaveLength(3);
    const first = fixture[0]!;
    expect(jobs[0]).toMatchObject({
      id: first.slug,
      kind: "task",
      org: first.project,
      location: { remote: true },
      pay: { max: first.maxBounty, currency: "USD", period: "unit", unit: "per valid report" },
      url: `https://immunefi.com/bug-bounty/${String(first.slug)}/`,
    });
    expect(jobs[0]!.apply_hint).toContain("immunefi.com/bug-bounty/");
    expect(jobs[0]!.tags).toContain("source:immunefi");
  });

  it("leaves out programs a new researcher cannot join", async () => {
    const closed = [{ ...fixture[0], slug: "invite", inviteOnly: true }, { ...fixture[1], slug: "paused", isPaused: true }, fixture[2]];
    const { jobs } = await immunefi.search!({}, testContext({ fetch: fixtureFetch(closed) }));
    expect(jobs.map((j) => j.id)).toEqual([fixture[2]!.slug]);
  });
});
