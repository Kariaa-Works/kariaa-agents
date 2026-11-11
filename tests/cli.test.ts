import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli/index.js";
import { JobCache } from "../src/core/jobCache.js";
import { WorkProtocol } from "../src/core/router.js";
import { builtInVerifiers } from "../src/verifiers/index.js";
import { fullStageConnector, searchOnlyConnector } from "./helpers/fakeConnectors.js";
import { wav } from "./helpers/media.js";

function io(): CliIo & { out: string; err: string } {
  const protocol = new WorkProtocol({
    connectors: [fullStageConnector(), searchOnlyConnector()],
    env: {},
    cache: new JobCache(),
    allowLocalFiles: true,
    verifiers: builtInVerifiers,
  });
  const box = {
    out: "",
    err: "",
    env: {},
    protocol,
    stdout: (t: string) => {
      box.out += t;
    },
    stderr: (t: string) => {
      box.err += t;
    },
  };
  return box;
}

describe("work CLI", () => {
  it("prints usage and rejects unknown commands", async () => {
    const h = io();
    expect(await main(["help"], h)).toBe(0);
    expect(h.out).toContain("work search");
    const bad = io();
    expect(await main(["frobnicate"], bad)).toBe(1);
    expect(bad.err).toContain("Unknown command");
    const badFlag = io();
    expect(await main(["search", "--nope"], badFlag)).toBe(1);
  });

  it("says which platforms were not asked when a default search finds nothing", async () => {
    const tiered = { ...fullStageConnector(), tier: "managed" as const };
    const protocol = new WorkProtocol({ connectors: [tiered, searchOnlyConnector()], env: {}, cache: new JobCache() });
    const h = { ...io(), protocol };
    let out = "";
    h.stdout = (t: string) => {
      out += t;
    };
    expect(await main(["search", "zzz-nothing-matches"], h)).toBe(0);
    expect(out).toContain("No matches.");
    expect(out).toContain("Asked only when named: fake-board.");
    out = "";
    expect(await main(["search", "zzz-nothing-matches", "--connector", "fake-board"], h)).toBe(0);
    expect(out).not.toContain("Asked only when named");
  });

  it("lists connectors and searches, as text and as JSON", async () => {
    const t = io();
    expect(await main(["connectors"], t)).toBe(0);
    expect(t.out).toContain("fake-tasks");
    const j = io();
    expect(await main(["search", "electrician", "--json", "--limit", "5"], j)).toBe(0);
    const parsed = JSON.parse(j.out) as { jobs: Array<{ id: string }> };
    expect(parsed.jobs.map((x) => x.id)).toContain("fake-board:l1");
    const text = io();
    expect(await main(["search", "--kind", "task"], text)).toBe(0);
    expect(text.out).toContain("fake-tasks:t1");
    expect(text.out).toContain("Read sentences aloud");
  });

  it("runs a task through apply, add, submit and status", async () => {
    const box = io();
    expect(await main(["apply", "fake-tasks:t1", "--answer", "q1=English", "--rate", "USD 1", "--json"], box)).toBe(1 - 1);
    expect(JSON.parse(box.out)).toMatchObject({ id: "fake-tasks:a1", stage: "work_needed" });
    box.out = "";
    expect(await main(["add", "fake-tasks:a1", "--text", "A written sample that is long enough.", "--json"], box)).toBe(0);
    expect(JSON.parse(box.out)).toMatchObject({ application_id: "fake-tasks:a1", progress: { received: 1, wanted: 2 } });
    box.out = "";
    expect(await main(["submit", "fake-tasks:a1"], box)).toBe(1);
    expect(box.err).toContain("not_ready");
    box.out = "";
    box.err = "";
    expect(await main(["add", "fake-tasks:a1", "--text", "Another written sample that is long enough."], box)).toBe(0);
    expect(await main(["submit", "fake-tasks:a1", "--note", "done"], box)).toBe(0);
    expect(box.out).toContain("in_review");
    box.out = "";
    expect(await main(["status", "fake-tasks:a1", "--json"], box)).toBe(0);
    expect(JSON.parse(box.out)).toMatchObject({ stage: "in_review" });
    box.out = "";
    expect(await main(["mine"], box)).toBe(0);
    expect(box.out).toContain("fake-tasks:a1");
    box.out = "";
    expect(await main(["link", "fake-tasks:a1"], box)).toBe(0);
    expect(box.out).toContain("https://fake.example/finish/a1");
    box.out = "";
    expect(await main(["me"], box)).toBe(0);
    expect(box.out).toContain("signed in");
    box.out = "";
    expect(await main(["profile", "--connector", "fake-tasks", "location=Accra, Ghana", "--json"], box)).toBe(0);
    expect(JSON.parse(box.out)).toMatchObject({ connector: "fake-tasks", profile: { location: "Accra, Ghana" } });
  });

  it("verifies files and text before sending, with exit codes per outcome", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "work-protocol-verify-"));
    const one = path.join(dir, "one.wav");
    const two = path.join(dir, "two.wav");
    const long = path.join(dir, "long.wav");
    writeFileSync(one, wav(10, 1));
    writeFileSync(two, wav(12, 2));
    writeFileSync(long, wav(45, 3));
    const pass = io();
    expect(await main(["verify", "fake-tasks:t1", one, two, "--answer", "q1=English"], pass)).toBe(0);
    expect(pass.out).toContain("Pass: 2 pieces accepted");
    expect(pass.out).toContain("USD 1");
    const fail = io();
    expect(await main(["verify", "fake-tasks:t1", one, long, "--answer", "q1=English", "--json"], fail)).toBe(2);
    expect(JSON.parse(fail.out)).toMatchObject({ outcome: "fail", job_id: "fake-tasks:t1" });
    const textCase = io();
    expect(
      await main(["verify", "fake-tasks:t2", "--text", "Positive: the customer says they will return, which is praise."], textCase),
    ).toBe(0);
    const nothing = io();
    expect(await main(["verify", "fake-tasks:t2"], nothing)).toBe(1);
    expect(nothing.err).toContain("Give files to check");
  });

  it("shows earnings and requests a payout", async () => {
    const box = io();
    expect(await main(["earnings"], box)).toBe(0);
    expect(box.out).toContain("fake-tasks: balance USD 30");
    expect(box.out).toContain("from USD 10 via paypal, venmo");
    box.out = "";
    expect(await main(["payout", "--connector", "fake-tasks", "--method", "paypal"], box)).toBe(0);
    expect(box.out).toContain("USD 30 via paypal");
    expect(box.out).toContain("requested");
    box.out = "";
    expect(await main(["payout", "--connector", "fake-tasks"], box)).toBe(1);
    expect(box.err).toContain("Missing --method");
    box.err = "";
    expect(await main(["payout", "--connector", "fake-board", "--method", "paypal", "--json"], box)).toBe(1);
    expect(JSON.parse(box.out)).toMatchObject({ error: "not_supported" });
  });

  it("prints protocol errors with their code, as JSON on request", async () => {
    const text = io();
    expect(await main(["get", "fake-board:l9"], text)).toBe(1);
    expect(text.err).toMatch(/^not_found: /u);
    const json = io();
    expect(await main(["get", "nonsense", "--json"], json)).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ error: "invalid_input" });
    const missing = io();
    expect(await main(["apply"], missing)).toBe(1);
    expect(missing.err).toContain("Missing <job-id>");
  });
});
