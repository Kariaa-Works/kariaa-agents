import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, testContext } from "../../core/conformance.js";
import { opire } from "./index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;

// The API returns every open reward and takes no query, so the query is applied to the rows.
describeConnectorConformance(opire, { search: {}, fetch: fixtureFetch(fixture), expectQueryInUrl: false });

describe("opire", () => {
  it("maps a reward: the amount in dollars, the issue, and how to claim it", async () => {
    const { jobs } = await opire.search!({}, testContext({ fetch: fixtureFetch(fixture) }));
    expect(jobs).toHaveLength(fixture.length);
    const rust = jobs.find((j) => j.tags?.includes("Rust"))!;
    expect(rust).toMatchObject({
      kind: "task",
      title: "research implementation for Windows",
      pay: { min: 42, max: 42, currency: "USD" },
      url: "https://github.com/radumarias/rencfs/issues/3",
      location: { remote: true },
    });
    expect(rust.apply_hint).toContain("/claim");
    expect(rust.tags).toEqual(expect.arrayContaining(["rencfs", "source:opire"]));
  });

  it("skips a row with no issue link", async () => {
    const { jobs } = await opire.search!({}, testContext({ fetch: fixtureFetch([{ id: "x", title: "No link" }, fixture[0]]) }));
    expect(jobs).toHaveLength(1);
  });
});
