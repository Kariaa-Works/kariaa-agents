#!/usr/bin/env node
/**
 * Scaffolds a connector, a verifier or a workflow folder from its `_template`.
 *
 *   npm run new-connector -- my-board
 *   npm run new-verifier -- my-check
 *   npm run new-workflow -- my-workflow
 */
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = {
  connector: {
    dir: "connectors",
    placeholders: ["example-board", "exampleBoard", "Example Board"],
    registry: "src/connectors/index.ts",
    list: "builtInConnectors",
  },
  verifier: {
    dir: "verifiers",
    placeholders: ["example-verifier", "exampleVerifier", "Example verifier"],
    registry: "src/verifiers/index.ts",
    list: "builtInVerifiers",
  },
  workflow: {
    dir: "workflows",
    base: ".",
    placeholders: ["example-workflow", "exampleWorkflow", "Example workflow"],
  },
};

const [kindName, id] = process.argv.slice(2);
const kind = KINDS[kindName];
if (!kind || !id || !/^[a-z0-9][a-z0-9-]*$/u.test(id) || id.startsWith("_")) {
  console.error("Usage: node scripts/scaffold.mjs <connector|verifier|workflow> <id>   (lowercase letters, digits and dashes)");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(root, kind.base ?? "src", kind.dir);
const source = path.join(base, "_template");
const target = path.join(base, id);
if (existsSync(target)) {
  console.error(`${target} already exists.`);
  process.exit(1);
}

const camel = id.replace(/-([a-z0-9])/gu, (_m, c) => c.toUpperCase());
const title = id
  .split("-")
  .map((part, i) => (i === 0 || kindName === "connector" ? part.charAt(0).toUpperCase() + part.slice(1) : part))
  .join(" ");
const [kebab, camelPlaceholder, titlePlaceholder] = kind.placeholders;

cpSync(source, target, { recursive: true });

function rewrite(dir) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) {
      rewrite(file);
      continue;
    }
    const text = readFileSync(file, "utf8").split(kebab).join(id).split(camelPlaceholder).join(camel).split(titlePlaceholder).join(title);
    writeFileSync(file, text);
  }
}
rewrite(target);

if (kindName === "workflow") {
  console.log(`Created workflows/${id}/ (${readdirSync(target).join(", ")}).

Next:
  1. Write the workflow in workflows/${id}/run.ts (or replace it with run.py, see workflows/bounty-brief).
  2. Fill in workflows/${id}/workflow.json and README.md.
  3. Record a run:  work trace --out workflows/${id}/trace.jsonl -- npx tsx workflows/${id}/run.ts
  4. Look at it:    work watch
  5. Check it:      npm run check:workflows -- ${id}`);
  process.exit(0);
}

console.log(`Created src/${kind.dir}/${id}/ (${readdirSync(target).join(", ")}).

Next:
  1. Fill in the TODOs in src/${kind.dir}/${id}/index.ts.
  2. Make src/${kind.dir}/${id}/index.test.ts real${kindName === "connector" ? " (save a trimmed response as fixtures/search.json)" : " (pass, fail and uncertain inputs)"}.
  3. Add this line to ${kind.registry}, append ${camel} to ${kind.list}, and add it to the export { … } block:
       import { ${camel} } from "./${id}/index.js";
  4. npm test${
    kindName === "connector"
      ? `
  5. npm run build, then:  work search <word> --connector ${id}
  6. Write the README.md, add a row to docs/catalog.md, list any key in .env.example (.github/CONTRIBUTING.md)`
      : ""
  }`);
