import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRuns } from "../src/cli/watch.js";
import { WorkProtocol } from "../src/core/router.js";
import { readTrace, redact, summarizeTrace, traceProtocol } from "../src/core/trace.js";
import { builtInVerifiers } from "../src/verifiers/index.js";
import { fullStageConnector } from "./helpers/fakeConnectors.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-trace-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("redact", () => {
  it("masks keys, tokens, emails and personal fields, and leaves bytes out", () => {
    const out = redact({
      api_key: "kra_abcdefghijklmnop",
      note: "write to sam@example.com with kra_abcdefghijklmnop",
      email: "sam@example.com",
      phone: "+1 555 0100",
      file: { base64: "AAAA", name: "clip.mp4" },
      url: "https://files.example/x?X-Amz-Signature=abc123&ok=1",
      ready: true,
      profile: { name: "Sam" },
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    expect(text).not.toContain("kra_abcdefghijklmnop");
    expect(text).not.toContain("sam@example.com");
    expect(text).not.toContain("555");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("AAAA");
    expect(out.ready).toBe(true);
    expect((out.file as Record<string, unknown>).name).toBe("clip.mp4");
  });

  it("cuts long text and long lists", () => {
    expect(String(redact("x".repeat(1000)))).toContain("(1000 chars)");
    expect((redact(Array.from({ length: 80 }, (_, i) => i)) as unknown[]).length).toBe(51);
  });
});

describe("traceProtocol", () => {
  it("records each call once, with its step, and a failed call with its code", async () => {
    const file = path.join(tempDir(), "run.jsonl");
    const protocol = traceProtocol(
      new WorkProtocol({ connectors: [fullStageConnector()], verifiers: builtInVerifiers, env: {}, cache: null }),
      file,
    );
    const found = await protocol.search({ connectors: ["fake-tasks"] });
    const job = found.jobs[0]!;
    await protocol.get(job.id);
    // verify reads the job itself; that inner get is not a call the workflow made.
    await protocol
      .verify(job.id, [{ text: "The quick brown fox jumps over the lazy dog near the quiet river bank." }])
      .catch(() => undefined);
    await expect(protocol.get("fake-tasks:missing")).rejects.toThrow();

    const events = readTrace(file);
    expect(events.map((e) => (e.type === "call" ? e.op : e.type))).toEqual(["search", "get", "verify", "get"]);
    const last = events.at(-1)!;
    expect(last.type === "call" && last.ok).toBe(false);
    const first = events[0]!;
    expect(first.type === "call" && first.step).toBe("find");

    const summary = summarizeTrace(events);
    expect(summary.calls).toBe(4);
    expect(summary.failed).toBe(1);
    expect(summary.found).toBe(found.jobs.length);
    expect(summary.connectors).toContain("fake-tasks");
  });
});

describe("work watch", () => {
  it("lists your runs, each workflow's committed run and the sample", () => {
    const cwd = tempDir();
    const pkg = tempDir();
    const line = JSON.stringify({
      type: "call",
      ts: new Date().toISOString(),
      op: "search",
      step: "find",
      input: [{}],
      ok: true,
      ms: 5,
      output: { jobs: [] },
    });
    fs.mkdirSync(path.join(cwd, ".work", "runs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".work", "runs", "20260101-000000-mine.jsonl"), `${line}\n`);
    fs.mkdirSync(path.join(cwd, "workflows", "demo"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "workflows", "demo", "trace.jsonl"), `${line}\n`);
    fs.writeFileSync(path.join(cwd, "workflows", "demo", "workflow.json"), JSON.stringify({ name: "demo", title: "Demo" }));
    fs.mkdirSync(path.join(cwd, "workflows", "_template"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "workflows", "_template", "trace.jsonl"), `${line}\n`);
    fs.mkdirSync(path.join(pkg, "viz"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "viz", "sample-run.jsonl"), `${line}\n`);

    const runs = listRuns(cwd, pkg);
    expect(runs.map((r) => r.id)).toEqual(["yours/20260101-000000-mine", "workflow/demo", "sample"]);
    expect(runs[1]!.title).toBe("Demo");
    expect(runs[0]!.summary.calls).toBe(1);
  });
});
