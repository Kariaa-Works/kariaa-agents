#!/usr/bin/env node
/**
 * Checks every folder under workflows/ the way CI does before a workflow PR merges:
 * a valid workflow.json, a README, a recorded run, and no secrets.
 *
 *   npm run check:workflows            every workflow
 *   npm run check:workflows -- scout   one workflow
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECRETS } from "./secret-patterns.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "workflows");
// Taking work: find … paid. Giving work out: post, hire, review, pay.
const STEPS = ["find", "apply", "do", "verify", "submit", "track", "paid", "post", "hire", "review", "pay"];
/** Workflows kept by the maintainers that need a paid model key to record a run. */
const SHIPPED_EXAMPLES = new Set([]);
const MAX_BYTES = 2 * 1024 * 1024;
/** Files that are not text; everything else under 1 MB is scanned for keys, whatever the language. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|mp[34]|wav|mov|woff2?|ttf|bin|pyc)$/iu;

function files(folder) {
  const out = [];
  for (const entry of readdirSync(folder)) {
    if (entry === "node_modules" || entry === "__pycache__" || entry === ".venv") continue;
    const file = path.join(folder, entry);
    if (statSync(file).isDirectory()) out.push(...files(file));
    else out.push(file);
  }
  return out;
}

function check(name) {
  const problems = [];
  const folder = path.join(dir, name);
  const rel = (file) => path.relative(root, file).split(path.sep).join("/");

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(folder, "workflow.json"), "utf8"));
  } catch {
    return ["workflow.json is missing or is not JSON"];
  }
  if (manifest.name !== name) problems.push(`workflow.json "name" must be "${name}" (the folder name)`);
  for (const field of ["title", "team", "description", "run"]) {
    const value = manifest[field];
    if (typeof value !== "string" || !value.trim() || value.includes("TODO")) problems.push(`workflow.json "${field}" is not filled in`);
  }
  if (!Array.isArray(manifest.steps) || manifest.steps.length === 0 || manifest.steps.some((s) => !STEPS.includes(s)))
    problems.push(`workflow.json "steps" must list one or more of: ${STEPS.join(", ")}`);

  const readme = path.join(folder, "README.md");
  if (!existsSync(readme)) problems.push("README.md is missing");
  else if (readFileSync(readme, "utf8").includes("TODO")) problems.push("README.md still has TODOs");
  // The template's own placeholders, left in the code that runs.
  for (const file of readdirSync(folder).filter((f) => /^run\.[a-z]+$/u.test(f)))
    if (/TODO what to look for/u.test(readFileSync(path.join(folder, file), "utf8")))
      problems.push(`${file} still searches for the template's placeholder`);

  const trace = path.join(folder, "trace.jsonl");
  if (manifest.example === true && !SHIPPED_EXAMPLES.has(name))
    problems.push('workflow.json "example" is for the maintainers\' examples; remove it and record a run');
  if (!existsSync(trace) && manifest.example === true && SHIPPED_EXAMPLES.has(name)) {
    // A maintainers' example that needs a paid model key; its run is recorded when one is available.
  } else if (!existsSync(trace))
    problems.push("trace.jsonl is missing: record a run with `work trace --out workflows/" + name + "/trace.jsonl -- <run command>`");
  else {
    const events = readFileSync(trace, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
    if (events.some((e) => e === null)) problems.push("trace.jsonl has a line that is not JSON");
    const calls = events.filter((e) => e?.type === "call");
    if (!events.some((e) => e?.type === "start")) problems.push("trace.jsonl was not recorded with `work trace`");
    if (calls.length === 0) problems.push("trace.jsonl has no calls: the run never reached the Work API");
    else if (calls.every((e) => !e.ok)) problems.push("every call in trace.jsonl failed");
  }

  let total = 0;
  for (const file of files(folder)) {
    const base = path.basename(file);
    const size = statSync(file).size;
    total += size;
    if (base === ".env" || base.startsWith(".env.")) problems.push(`${rel(file)}: do not commit env files`);
    if (BINARY.test(base) || size > 1024 * 1024) continue;
    const text = readFileSync(file, "utf8");
    for (const [pattern, what] of SECRETS) if (pattern.test(text)) problems.push(`${rel(file)}: looks like it contains ${what}`);
  }
  if (total > MAX_BYTES) problems.push(`the folder is ${(total / 1048576).toFixed(1)} MB; keep it under 2 MB`);
  return problems;
}

const wanted = process.argv.slice(2);
const names = readdirSync(dir).filter((name) => !name.startsWith("_") && statSync(path.join(dir, name)).isDirectory());
const targets = wanted.length ? wanted : names;
let failed = 0;
for (const name of targets) {
  if (!names.includes(name)) {
    console.error(`✗ ${name}: no such folder under workflows/`);
    failed += 1;
    continue;
  }
  const problems = check(name);
  if (problems.length === 0) console.log(`✓ ${name}`);
  else {
    failed += 1;
    console.error(`✗ ${name}`);
    for (const problem of problems) console.error(`    ${problem}`);
  }
}
process.exit(failed ? 1 : 0);
