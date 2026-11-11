import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JobCache, defaultCacheFile } from "../src/core/jobCache.js";
import type { Job } from "../src/core/types.js";

const job = (n: number): Job => ({
  id: `b:${n}`,
  connector: "b",
  kind: "listing",
  title: `Job ${n}`,
  stages: [],
  url: `https://x.example/${n}`,
});

describe("JobCache", () => {
  it("keeps the newest entries and evicts the oldest", () => {
    const cache = new JobCache({ max: 2 });
    cache.set(job(1));
    cache.set(job(2));
    expect(cache.get("b:1")?.title).toBe("Job 1");
    cache.set(job(3));
    expect(cache.get("b:2")).toBeUndefined();
    expect(cache.get("b:1")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("expires entries", async () => {
    const cache = new JobCache({ ttlMs: 5 });
    cache.set(job(1));
    await new Promise((r) => setTimeout(r, 15));
    expect(cache.get("b:1")).toBeUndefined();
  });

  it("persists to a file and survives a corrupt one", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "work-protocol-cache-"));
    const file = path.join(dir, "sub", "jobs.json");
    const first = new JobCache({ file });
    first.setMany([job(1), job(2)]);
    first.save();
    const second = new JobCache({ file });
    expect(second.get("b:2")?.url).toBe("https://x.example/2");
    writeFileSync(file, "{not json");
    const third = new JobCache({ file });
    expect(third.size).toBe(0);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          { at: Date.now(), job: { id: "broken" } },
          { at: Date.now(), job: job(5) },
        ],
      }),
    );
    const fourth = new JobCache({ file });
    expect(fourth.size).toBe(1);
    expect(fourth.get("b:5")).toBeDefined();
  });

  it("names the default file from the environment", () => {
    expect(defaultCacheFile({ WORK_CACHE_DIR: "/tmp/wp" })).toBe(path.join("/tmp/wp", "jobs.json"));
    expect(defaultCacheFile({})).toContain("work-protocol");
  });
});
