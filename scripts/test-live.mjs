#!/usr/bin/env node
/**
 * The contract tests against the real platforms, read-only. Works in every shell.
 *
 *   npm run test:live                           every connector
 *   npm run test:live -- src/connectors/my-board   one folder
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const result = spawnSync("npx", ["vitest", "run", "--config", "scripts/vitest.config.ts", ...(args.length ? args : ["src/connectors"])], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, LIVE: "1" },
});
process.exit(result.status ?? 1);
