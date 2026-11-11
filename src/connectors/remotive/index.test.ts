import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, testContext } from "../../core/conformance.js";
import { remotive } from "./index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8")) as unknown;

describeConnectorConformance(remotive, { search: {}, fetch: fixtureFetch(fixture), minResults: 3 });

describe("remotive mapping", () => {
  it("maps a row to a remote listing with source credit", async () => {
    const calls: string[] = [];
    const ctx = testContext({ fetch: fixtureFetch((url) => (calls.push(url), fixture)) });
    const { jobs } = await remotive.search!({ query: "engineer", limit: 2 }, ctx);
    expect(calls[0]).toContain("search=engineer");
    expect(calls[0]).toContain("limit=4");
    expect(jobs).toHaveLength(2);
    const job = jobs[0]!;
    expect(job).toMatchObject({
      id: "2091158",
      kind: "listing",
      title: "Software Engineer, AI Coding Tasks",
      org: "Askable",
      location: { text: "Worldwide", remote: true },
      pay: { text: "$1000 per task" },
    });
    expect(job.url).toBe("https://remotive.com/remote-jobs/software-development/software-engineer-ai-coding-tasks-2091158");
    expect(job.posted_at).toBe("2026-10-17T16:04:29.000Z");
    expect(job.tags).toContain("source:remotive");
    expect(job.tags).toContain("Software Development");
    expect(job.summary).not.toContain("<p>");
    expect(job.summary!.length).toBeLessThanOrEqual(301);
  });

  it("filters by place on the candidate location, keeping worldwide rows", async () => {
    const ctx = testContext({ fetch: fixtureFetch(fixture) });
    const { jobs } = await remotive.search!({ query: "engineer", location: "Accra" }, ctx);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect(/worldwide|accra|anywhere/iu.test(job.location?.text ?? "")).toBe(true);
  });
});
