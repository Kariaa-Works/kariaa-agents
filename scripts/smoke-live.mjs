#!/usr/bin/env node
/**
 * Runs the built CLI and the stdio MCP server against the real sources.
 *
 *   npm run build && npm run smoke:live
 *
 * Read-only by default. With KARIAA_API_KEY, SMOKE_WRITE=1 and SMOKE_TASK=<task uuid>
 * it also applies to that task, adds one written sample when the task takes text,
 * and prints the application id so the rows can be cleaned up afterwards.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli", "index.js");
let failures = 0;

// Synthetic media with real headers (see tests/helpers/media.ts).
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u16le = (n) => [n & 255, (n >>> 8) & 255];
const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const filler = (length, seed) => Array.from({ length }, (_, i) => (i * 31 + seed * 17 + ((i * seed) % 13)) & 255);
const box = (type, body) => [...u32be(8 + body.length), ...ascii(type), ...body];
function syntheticWav(seconds, seed, rate = 2000) {
  const size = Math.round(seconds * rate);
  return new Uint8Array([
    ...ascii("RIFF"),
    ...u32le(36 + size),
    ...ascii("WAVE"),
    ...ascii("fmt "),
    ...u32le(16),
    ...u16le(1),
    ...u16le(1),
    ...u32le(rate),
    ...u32le(rate),
    ...u16le(1),
    ...u16le(8),
    ...ascii("data"),
    ...u32le(size),
    ...filler(size, seed),
  ]);
}
function syntheticMp4(seconds, seed) {
  const mvhd = box("mvhd", [
    0,
    0,
    0,
    0,
    ...u32be(0),
    ...u32be(0),
    ...u32be(1000),
    ...u32be(Math.round(seconds * 1000)),
    ...u32be(0x00010000),
    1,
    0,
    ...new Array(10).fill(0),
    ...new Array(36).fill(0),
    ...new Array(24).fill(0),
    ...u32be(2),
  ]);
  return new Uint8Array([
    ...box("ftyp", [...ascii("isom"), ...u32be(0), ...ascii("isom")]),
    ...box("moov", mvhd),
    ...box("mdat", filler(9000, seed)),
  ]);
}
function syntheticPng(width, height, seed) {
  const ihdr = [...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height), 8, 2, 0, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...ihdr,
    ...u32be(1500),
    ...ascii("IDAT"),
    ...filler(1500, seed),
    0,
    0,
    0,
    0,
    ...u32be(0),
    ...ascii("IEND"),
    0xae,
    0x42,
    0x60,
    0x82,
  ]);
}

function step(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: process.env, timeout: 120_000 });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

// 1. CLI, read-only
const connectors = run(["connectors", "--json"]);
step(
  "work connectors --json",
  connectors.code === 0 && Array.isArray(connectors.json?.connectors),
  `${connectors.json?.connectors?.length ?? 0} connectors`,
);

const tasks = run(["search", "--kind", "task", "--json", "--limit", "50"]);
const taskRows = tasks.json?.jobs ?? [];
// A fan-out search passes on rows; a source that failed is named here and judged on its own below.
const partials = (result) => (result.json?.partial ?? []).map((p) => `${p.connector}: ${p.error.code}`).join(", ") || "none";
step("work search --kind task", tasks.code === 0 && taskRows.length > 0, `${taskRows.length} tasks; failed sources: ${partials(tasks)}`);

// Job boards are asked when named, so name them: this checks a located search across several of them.
const mixed = run([
  "search",
  "electrician",
  "--in",
  "Accra, Ghana",
  "--connector",
  "kariaa-jobs",
  "--connector",
  "dice",
  "--json",
  "--limit",
  "12",
]);
const mixedRows = mixed.json?.jobs ?? [];
const sources = [...new Set(mixedRows.map((j) => j.connector))];
step(
  "work search electrician --in 'Accra, Ghana' --connector kariaa-jobs --connector dice",
  mixed.code === 0 && mixedRows.length > 0,
  `${mixedRows.length} jobs from ${sources.join(", ") || "nobody"}; failed sources: ${partials(mixed)}`,
);

const firstTask = taskRows[0];
if (firstTask) {
  const got = run(["get", firstTask.id, "--json"]);
  step(
    `work get ${firstTask.id}`,
    got.code === 0 && got.json?.title === firstTask.title && Boolean(got.json?.requirements),
    `${got.json?.title ?? got.stderr.trim()}`,
  );
}

const firstListing = mixedRows.find((j) => j.kind === "listing");
if (firstListing) {
  const got = run(["get", firstListing.id, "--json"]);
  step(
    `work get ${firstListing.id} (new process, from cache)`,
    got.code === 0 && got.json?.id === firstListing.id,
    got.code === 0 ? got.json?.title : got.stderr.trim(),
  );
}

const me = run(["me", "--json"]);
step(
  "work me",
  me.code === 0 && Array.isArray(me.json?.accounts),
  JSON.stringify(me.json?.accounts?.map((a) => `${a.connector}:${a.signed_in ? "signed in" : "anonymous"}`) ?? []),
);

// 1b. One read-only search per connector against its real server (keyed ones only when the key is set).
const SAMPLE = {
  kariaa: ["--kind", "task"],
  "kariaa-jobs": ["electrician"],
  remotive: ["support"],
  "superteam-earn": [],
  kaggle: ["titanic"],
  dice: ["electrician"],
  "near-agent-market": [],
  opentask: ["python"],
  "whop-bounties": [],
  algora: ["typescript"],
  yeswehack: [],
};
for (const c of connectors.json?.connectors ?? []) {
  if (c.auth.required && !c.auth.configured) {
    console.log(`skip  ${c.id}: ${(c.auth.env ?? []).join(", ")} not set`);
    continue;
  }
  const args = SAMPLE[c.id] ?? ["work"];
  const r = run(["search", ...args, "--connector", c.id, "--json", "--limit", "5"]);
  const rows = r.json?.jobs ?? [];
  const failed = r.json?.partial?.find((p) => p.connector === c.id);
  step(
    `work search ${args.join(" ") || "(no query)"} --connector ${c.id}`,
    r.code === 0 && !failed,
    failed ? `${failed.error.code}: ${failed.error.message}` : `${rows.length} rows${rows[0] ? `: ${rows[0].title}` : ""}`,
  );
}

// 2. MCP over stdio with the official client
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { ...process.env }, stderr: "pipe" });
const client = new Client({ name: "smoke", version: "0" });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  step("mcp tools/list", tools.length === 24, `${tools.length} tools`);
  if (firstTask) {
    const full = await client.callTool({ name: "get_job", arguments: { job_id: firstTask.id } });
    const kinds = full.structuredContent?.requirements?.files?.kinds ?? [];
    const count = full.structuredContent?.requirements?.files?.count ?? 1;
    const maxSeconds = full.structuredContent?.requirements?.files?.max_seconds ?? 20;
    const pieces = [];
    for (let i = 0; i < count; i += 1) {
      if (kinds.includes("video"))
        pieces.push({
          file: { base64: Buffer.from(syntheticMp4(Math.min(maxSeconds, 20), i + 1)).toString("base64"), name: `clip${i + 1}.mp4` },
        });
      else if (kinds.includes("audio"))
        pieces.push({
          file: { base64: Buffer.from(syntheticWav(Math.min(maxSeconds, 20), i + 1)).toString("base64"), name: `clip${i + 1}.wav` },
        });
      else if (kinds.includes("image"))
        pieces.push({ file: { base64: Buffer.from(syntheticPng(640, 480, i + 1)).toString("base64"), name: `photo${i + 1}.png` } });
      else pieces.push({ text: `Smoke answer ${i + 1}: this is a written sample long enough to count as an answer.` });
    }
    const answers = {};
    for (const q of full.structuredContent?.requirements?.questions ?? []) {
      if (q.required) answers[q.id] = q.options?.[0] ?? "smoke";
    }
    const verified = await client.callTool({ name: "verify_work", arguments: { job_id: firstTask.id, work: pieces, answers } });
    step(
      `mcp verify_work on ${firstTask.id} (${kinds.join("/")} × ${count})`,
      !verified.isError && verified.structuredContent?.outcome !== "fail",
      verified.isError ? JSON.stringify(verified.structuredContent) : verified.structuredContent?.summary,
    );
  }
  const earnings = await client.callTool({ name: "my_earnings", arguments: { connector: "kariaa" } });
  const kariaaEarnings = earnings.structuredContent?.earnings?.find((e) => e.connector === "kariaa");
  const kariaaFailure = earnings.structuredContent?.partial?.find((p) => p.connector === "kariaa");
  step(
    "mcp my_earnings on kariaa: a balance, or not_supported / auth_required in partial",
    !earnings.isError && (Boolean(kariaaEarnings) || ["not_supported", "auth_required"].includes(kariaaFailure?.error?.code)),
    kariaaEarnings
      ? `balance ${kariaaEarnings.balance?.currency} ${kariaaEarnings.balance?.amount}`
      : `${kariaaFailure?.error?.code}: ${kariaaFailure?.error?.message}`,
  );
  const guide = await client.readResource({ uri: "work://guide" });
  step("mcp work://guide", (guide.contents[0]?.text ?? "").includes("search_jobs"));
  const search = await client.callTool({ name: "search_jobs", arguments: {} });
  const count = search.structuredContent?.count ?? 0;
  step("mcp search_jobs (no query)", !search.isError && count > 0, `${count} tasks`);
  if (firstTask) {
    const job = await client.callTool({ name: "get_job", arguments: { job_id: firstTask.id } });
    step("mcp get_job", !job.isError && job.structuredContent?.id === firstTask.id);
  }
  const listing = await client.callTool({ name: "apply_to_job", arguments: { job_id: "remotive:1" } });
  step(
    "mcp apply_to_job on a listing answers not_supported or not_found",
    listing.isError === true && ["not_supported", "not_found"].includes(listing.structuredContent?.error),
  );

  // 3. Optional write flow
  if (process.env.KARIAA_API_KEY && process.env.SMOKE_WRITE === "1" && process.env.SMOKE_TASK) {
    const jobId = `kariaa:${process.env.SMOKE_TASK}`;
    const task = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    const answers = {};
    for (const q of task.structuredContent?.requirements?.questions ?? []) {
      if (!q.required) continue;
      answers[q.id] =
        q.type === "multiselect" ? [q.options?.[0] ?? "smoke"] : q.type === "select" ? (q.options?.[0] ?? "smoke") : "smoke test answer";
    }
    const applied = await client.callTool({ name: "apply_to_job", arguments: { job_id: jobId, answers, preferred_rate: "USD 1 (smoke)" } });
    step(
      "mcp apply_to_job (write)",
      !applied.isError,
      applied.isError ? JSON.stringify(applied.structuredContent) : `${applied.structuredContent?.id} ${applied.structuredContent?.stage}`,
    );
    const appId = applied.structuredContent?.id;
    const text = task.structuredContent?.requirements?.text;
    if (appId && text && applied.structuredContent?.stage === "work_needed") {
      const added = await client.callTool({
        name: "add_work",
        arguments: { application_id: appId, text: "Smoke test answer: positive, because the customer says they will come back." },
      });
      step(
        "mcp add_work (text)",
        !added.isError,
        added.isError ? JSON.stringify(added.structuredContent) : JSON.stringify(added.structuredContent?.progress),
      );
    }
    if (appId) {
      const status = await client.callTool({ name: "get_application", arguments: { application_id: appId } });
      step("mcp get_application", !status.isError, `${status.structuredContent?.stage}`);
      console.log(`\nClean up afterwards: application ${appId}`);
    }
  } else {
    console.log("skip  write flow (set KARIAA_API_KEY, SMOKE_WRITE=1 and SMOKE_TASK=<task uuid>)");
  }
} finally {
  await client.close().catch(() => {});
}

console.log(failures === 0 ? "\nAll live checks passed." : `\n${failures} live check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
