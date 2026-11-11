#!/usr/bin/env node
/**
 * Checks what a pull request changes, the way CI does:
 *   - nothing it adds looks like a key or token, in any file;
 *   - a workflow pull request touches only its own folder under workflows/ (and docs/CHANGELOG.md);
 *   - a new connector is registered, listed in the catalog and no longer the untouched template.
 *
 *   node scripts/check-pr.mjs origin/main
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECRETS } from "./secret-patterns.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] ?? "origin/main";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

let changed;
try {
  changed = git("diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`).split("\n").filter(Boolean);
} catch (error) {
  console.error(`Could not compare with ${base}: ${error.message.split("\n")[0]}`);
  process.exit(1);
}

const problems = [];

// Secrets: only the lines this pull request adds, so fixtures already in the repo are not re-judged.
const added = git("diff", "--unified=0", "--diff-filter=ACMR", `${base}...HEAD`);
let file = "";
for (const line of added.split("\n")) {
  if (line.startsWith("+++ b/")) file = line.slice(6);
  else if (line.startsWith("+") && !line.startsWith("+++")) {
    for (const [pattern, what] of SECRETS) if (pattern.test(line)) problems.push(`${file}: an added line looks like it contains ${what}`);
  }
}
for (const name of changed) {
  const base_ = path.basename(name);
  if (base_ === ".env" || (base_.startsWith(".env.") && base_ !== ".env.example")) problems.push(`${name}: do not commit env files`);
  const full = path.join(root, name);
  if (existsSync(full) && statSync(full).size > 5 * 1024 * 1024) problems.push(`${name}: over 5 MB`);
}

// A workflow pull request stays in its folder.
const folders = new Set(changed.filter((f) => f.startsWith("workflows/")).map((f) => f.split("/")[1]));
folders.delete("_template");
if (folders.size > 1) problems.push(`one workflow per pull request (this one touches ${[...folders].join(", ")})`);
if (folders.size === 1) {
  const [folder] = folders;
  const isNew = !git("ls-tree", "--name-only", base, `workflows/${folder}/`).trim();
  const outside = changed.filter((f) => !f.startsWith(`workflows/${folder}/`) && f !== "docs/CHANGELOG.md");
  if (isNew && outside.length)
    problems.push(
      `a new workflow touches only workflows/${folder}/ and docs/CHANGELOG.md (also changed: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", …" : ""})`,
    );
  const manifest = path.join(root, "workflows", folder, "workflow.json");
  if (existsSync(manifest) && /"example"\s*:\s*true/u.test(readFileSync(manifest, "utf8")) && isNew)
    problems.push(`workflows/${folder}/workflow.json: remove "example" and record a run`);
}

// A new connector is finished: registered, in the catalog, described, and tested against its real source.
const connectors = new Set(changed.filter((f) => f.startsWith("src/connectors/") && f.split("/").length > 3).map((f) => f.split("/")[2]));
connectors.delete("_template");
for (const id of connectors) {
  if (git("ls-tree", "--name-only", base, `src/connectors/${id}/`).trim()) continue;
  const read = (file) => (existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), "utf8") : "");
  const dir = `src/connectors/${id}`;
  if (!read("src/connectors/index.ts").includes(`./${id}/index.js`)) problems.push(`${dir}: not registered in src/connectors/index.ts`);
  if (!read("docs/catalog.md").includes(`\`${id}\``)) problems.push(`${dir}: no row for \`${id}\` in docs/catalog.md`);
  const readme = read(`${dir}/README.md`);
  if (!readme.trim() || readme.includes("TODO")) problems.push(`${dir}/README.md is missing or still has TODOs`);
  if (/\bTODO\b/u.test(read(`${dir}/index.ts`))) problems.push(`${dir}/index.ts still has TODOs`);
  if (/live:\s*false/u.test(read(`${dir}/index.test.ts`)))
    problems.push(`${dir}/index.test.ts still has live: false; remove it and run npm run test:live -- ${dir}`);
}

if (problems.length === 0) {
  console.log(`✓ ${changed.length} changed file${changed.length === 1 ? "" : "s"} checked against ${base}`);
  process.exit(0);
}
for (const problem of [...new Set(problems)]) console.error(`✗ ${problem}`);
process.exit(1);
