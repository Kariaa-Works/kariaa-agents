import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, testContext } from "../../core/conformance.js";
import { mapRemoteOkJob, remoteok } from "./index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8")) as unknown;

describeConnectorConformance(remoteok, { search: { limit: 3 }, fetch: fixtureFetch(fixture), minResults: 3 });

describe("Remote OK mapping", () => {
  it("skips the feed's terms row and searches the current feed locally", async () => {
    const calls: string[] = [];
    const ctx = testContext({ fetch: fixtureFetch((url) => (calls.push(url), fixture)) });
    const { jobs } = await remoteok.search!({ query: "strategy coach", limit: 2 }, ctx);

    expect(calls).toEqual(["https://remoteok.com/api"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "1137717",
      kind: "listing",
      title: "Strategy & Operations Coach APAC",
      org: "Mento",
      location: { remote: true },
      url: "https://remoteok.com/remote-jobs/remote-strategy-operations-coach-apac-mento-1137717",
      posted_at: "2026-11-11T00:00:15.000Z",
    });
    expect(jobs[0]!.tags).toContain("source:remoteok");
    expect(jobs[0]!.summary).not.toContain("<p");
  });

  it("keeps salary figures without inventing a currency or pay period", () => {
    const job = mapRemoteOkJob({
      id: "salary-example",
      position: "Software engineer",
      url: "https://remoteOK.com/remote-jobs/software-engineer-salary-example",
      salary_min: 90000,
      salary_max: 120000,
      salary_currency: "USD",
    });

    expect(job?.pay).toEqual({ text: "USD 90,000–120,000" });
    expect(job?.url).toBe("https://remoteok.com/remote-jobs/software-engineer-salary-example");
  });

  it("rejects links that do not point to Remote OK", () => {
    expect(mapRemoteOkJob({ id: "1", position: "Role", url: "https://example.com/job" })).toBeNull();
  });
});
