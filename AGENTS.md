# AGENTS.md

Reference for coding agents (and people who want everything on one page). The short introduction is [README.md](README.md).

## What this repo is

A toolkit for agents that take part in the economy: earning (find paid work, do it, get paid), selling (make something and sell it through a platform), and paying (give work to a person or another agent and pay for it). It is a TypeScript library, a command (`work`) and an MCP server that put many platforms behind one set of calls. Each platform is a **connector**. An agent built on the API is a **workflow**. A local check of a piece of work is a **verifier**.

- Node 20 or newer, ESM only. Relative imports end in `.js` even though the files are `.ts`.
- Two runtime dependencies: `@modelcontextprotocol/sdk` and `zod` (version 4: `z.record` takes the key type first).
- `work` runs the compiled code in `dist/`. After changing anything under `src/`, run `npm run build` before using `work`; `npm run work -- <args>` runs the source directly.

## Layout

| path                      | what is there                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/core`                | types (`types.ts`), connector contract (`connector.ts`), router (`router.ts`), errors, HTTP, files, traces |
| `src/core/conformance.ts` | the test suites every connector and verifier runs, plus `fixtureFetch` and `testContext`                   |
| `src/connectors/<id>`     | one folder per platform: `index.ts`, `index.test.ts`, `README.md`, `fixtures/`                             |
| `src/connectors/index.ts` | the registry: import, `builtInConnectors` list, `export { … }` block                                       |
| `src/verifiers/<id>`      | one folder per verifier; registry in `src/verifiers/index.ts`                                              |
| `src/mcp`                 | the MCP server (`server.ts`), stdio and HTTP entry points, the `work://guide` text (`guide.ts`)            |
| `src/cli`                 | the `work` command (`index.ts`), `work trace`, `work watch`                                                |
| `src/search`              | the optional local search index (`work index`)                                                             |
| `workflows/<name>`        | one folder per workflow: run file, `workflow.json`, `README.md`, `trace.jsonl`                             |
| `viz`                     | the page `work watch` serves, one HTML file                                                                |
| `tests`                   | router, MCP, CLI and helper tests; fakes under `tests/helpers`                                             |
| `scripts`                 | scaffolds, the workflow and pull request checks, live smoke tests                                          |
| `scripts` (config)        | `tsconfig.build.json`, `vitest.config.ts` and the `Dockerfile` live here to keep the root short            |
| `.github`                 | CI, issue and pull request templates, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`               |
| `docs`                    | one guide per topic (listed at the end)                                                                    |

`_template` folders under `src/connectors`, `src/verifiers` and `workflows` are what the scaffolds copy. Edit a template only to change what new contributions start from.

## Commands

```bash
npm install
npm run build              # tsc to dist/
npm test                   # unit and contract tests, no network
npm run typecheck
npm run format             # prettier --write; CI runs format:check
npm run check:workflows    # every workflow folder is complete; add -- <name> for one
npm run test:live -- src/connectors/<id>   # the contract tests against the real platform, read-only
npm run smoke:live         # read-only run of the CLI and MCP server against the platforms
node scripts/check-pr.mjs origin/main      # what CI checks about a pull request's changes

npm run new-workflow -- <name>
npm run new-connector -- <id>
npm run new-verifier -- <id>
```

CI runs, in order: `format:check`, `typecheck`, `test`, `build`, `check:workflows`, `work --version`, and on pull requests `check-pr.mjs`. It runs on Linux (Node 20 and 22), Windows and macOS, with no secrets, so it works on forks.

## The loop

Every platform supports the steps it can. A job's `stages` say which ones.

| step     | CLI                             | MCP tool                             | library                         |
| -------- | ------------------------------- | ------------------------------------ | ------------------------------- |
| find     | `work search`, `work get`       | `search_jobs`, `get_job`             | `search()`, `get()`             |
| apply    | `work apply <job>`              | `apply_to_job`                       | `apply()`                       |
| do       | `work add <application> <file>` | `add_work`                           | `upload()`                      |
| verify   | `work verify <job> <file>`      | `verify_work`                        | `verify()`                      |
| submit   | `work submit <application>`     | `submit_work`                        | `submit()`                      |
| track    | `work status`, `work mine`      | `get_application`, `my_applications` | `status()`, `list()`            |
| get paid | `work earnings`, `work payout`  | `my_earnings`, `request_payout`      | `earnings()`, `requestPayout()` |

- Ids are `<connector>:<native id>`, like `kariaa:3f2a…`. Pass them back exactly as returned.
- Failures are a `ProtocolError` with a code: `not_supported`, `not_found`, `auth_required`, `rate_limited`, `invalid_input`, `not_ready`, `wrong_stage`, `already_exists`, `timeout`, `upstream_error`, `forbidden`, `approval_required`, `handoff_required`. [docs/protocol.md](docs/protocol.md) has every shape.
- Every `work` command takes `--json`. `work help <command>` describes one command.
- A task whose last line in `work search` ends in `agent-allowed` is one the platform says an agent may do.

Library use:

```ts
import { createProtocol } from "kariaa-agents"; // inside this repo: "../../src/index.js"

const work = await createProtocol(); // reads keys from .env
try {
  const { jobs } = await work.search({ query: "data labeling", kind: "task", direct_apply: true });
  const first = jobs[0];
  if (first) {
    const job = await work.get(first.id);
    const draft = "…the work your agent produced…";

    const check = await work.verify(job.id, [{ text: draft }]); // checked locally; nothing is sent
    if (check.outcome === "pass") {
      const application = await work.apply(job.id, { note: "Why I fit." });
      await work.upload(application.id, { text: draft }); // or { file: { path: "./clip.mp4" } }
      await work.submit(application.id);
    }
  }
} finally {
  await work.close();
}
```

MCP use: `node dist/cli/index.js mcp` is the stdio server (24 tools and a `work://guide` resource). Host configuration is in [docs/mcp.md](docs/mcp.md).

## Which platforms a search asks

A search that names no connector asks only the connectors with a **tier** (`managed`, `self`, `discover`) whose keys are set. The others are asked when named: `--connector <id>` or `connectors: ["<id>"]`. `WORK_CATALOG=all` asks every platform. An empty search prints which platforms were not asked and which key each needs. A new connector has no tier; a maintainer gives it one after a live run. [docs/catalog.md](docs/catalog.md) lists every platform, its tier and its keys.

## Keys and settings

- Keys live in `.env` (git ignores it); `.env.example` lists every one. `createProtocol()` and `work` both read `.env`.
- `KARIAA_API_KEY` allows 60 calls a minute, 2,000 calls and 60 writes a day, and 30 searches an hour.
- `work connect` says what each platform needs. Kept sign-ins and the listing cache are in `WORK_CACHE_DIR` (default `~/.cache/work-protocol`). Point it at an empty folder to behave like a new user.
- Other settings: `WORK_SEARCH_TIMEOUT_MS`, `WORK_MAX_FILE_BYTES`, `WORK_LOG`, `WORK_HTTP_TOKEN`, `WORK_CONNECTOR_MODULES`. [docs/mcp.md](docs/mcp.md) has the table.

## Adding a workflow

1. `npm run new-workflow -- <name>` creates `workflows/<name>/`.
2. Write `run.ts` (or `run.py`, or any language: see `workflows/bounty-brief` for MCP over stdio with no packages).
3. Fill in `workflow.json` and `README.md`. `needs_key` is `true` only when it cannot run at all without a key; `env` names every variable it reads.
4. Record a run: `work trace --out workflows/<name>/trace.jsonl -- <run command>`. Keys, emails, phone numbers and home folders are masked in the recording; read it through once anyway.
5. `npm run check:workflows -- <name>` must pass.
6. The pull request touches only `workflows/<name>/` and `docs/CHANGELOG.md`. One workflow per pull request.

Rules for what a workflow does: cap writes per run in code; call `verify` and get a pass before anything is sent; follow each job's own rules (a task that says no AI tools, or asks for the person's own voice, photos or video, is not for an agent); put nothing in an application that the person did not give you; no bulk applying.

## Adding a connector

1. `npm run new-connector -- <id>` creates `src/connectors/<id>/` from the JSON-board template.
2. Fill in the TODOs in `index.ts`. For more than search, implement the `Connector` methods the platform supports. A platform with an MCP server needs no code: `work draft <url> --out src/connectors` ([docs/mcp-profiles.md](docs/mcp-profiles.md)).
3. Save one real response, trimmed to three rows, as `fixtures/search.json`; load it in `index.test.ts`; remove `live: false` from the test.
4. Register it in `src/connectors/index.ts`: the import, the `builtInConnectors` list and the `export { … }` block.
5. `npm test`, then `npm run test:live -- src/connectors/<id>`, then `npm run build` and `work search <word> --connector <id>`.
6. Write the folder's `README.md`, add a row to `docs/catalog.md`, list any key in `.env.example`, add a line to `docs/CHANGELOG.md`.

`check-pr.mjs` fails a new connector that is not registered, has no catalog row, still has TODOs, or still says `live: false`.

Connector rules:

- Every request goes through `ctx.fetch` with `ctx.signal`. The conformance suite replaces `ctx.fetch`, so a connector that uses the global `fetch`, or returns a fixed list without fetching, fails. `fetchJson` in `src/core/http.ts` does this and turns a failing source into a `ProtocolError`.
- Return jobs and applications in their native shape: no connector prefix on ids, no `connector` field. The router adds both.
- Throw `ProtocolError` with the code that fits. Never log credentials.
- Public or documented APIs only. No scraping against a site's terms. Nothing that costs money per call.
- Tests use fixtures, never the network. Never call a platform's write, posting or payment endpoints from a test or smoke run.

## Adding a verifier

`npm run new-verifier -- <id>`, implement `verify`, add pass, fail and uncertain inputs to `index.test.ts` with `describeVerifierConformance`, register it in `src/verifiers/index.ts`, describe it in `docs/verifiers.md`. Built-in verifiers are deterministic: no network, no clock, no randomness, no model.

## Giving work out

`post`, `postings`, `offers`, `award`, `review`, `pay`, `cancel` exist on the connector contract, the router, the MCP server and the CLI. No shipped connector implements them yet. `tests/helpers/fakeMarket.ts` is a complete in-memory marketplace to build against and `describeBuyerConformance` is the suite. `pay` is always two calls: the first returns what would move and a signed token good for fifteen minutes; only the second, with the token, moves money. [docs/hire.md](docs/hire.md).

## Things that go wrong

- `work` prints old behaviour after an edit: `npm run build` was skipped.
- `not_found: No connector "<id>"`: the connector is not registered in `src/connectors/index.ts`, or `dist/` is stale.
- `No matches.` on a search with no `--connector`: only tiered platforms with keys were asked; the hint under it names the rest.
- A source "did not answer": that platform failed or timed out; the other results are still valid. `--json` has the full message under `partial`.
- `format:check` fails: run `npm run format`.
- PowerShell: `npm run <script> -- <args>` works as written. If `work` is blocked by the execution policy, use `node dist/cli/index.js`.
- Never commit `.env`, tokens or anything personal. `check-pr.mjs` scans added lines for key shapes and rejects them.

## Docs

| file                                         | covers                                                  |
| -------------------------------------------- | ------------------------------------------------------- |
| [docs/protocol.md](docs/protocol.md)         | every type, stage, error code and guarantee             |
| [docs/cli.md](docs/cli.md)                   | the `work` command                                      |
| [docs/mcp.md](docs/mcp.md)                   | the MCP tools, host setup, HTTP mode, environment       |
| [docs/workflows.md](docs/workflows.md)       | writing, recording and checking a workflow              |
| [docs/connectors.md](docs/connectors.md)     | the connector contract, board helpers, tests            |
| [docs/mcp-profiles.md](docs/mcp-profiles.md) | linking a platform's MCP server without code            |
| [docs/verifiers.md](docs/verifiers.md)       | the verifier contract                                   |
| [docs/catalog.md](docs/catalog.md)           | platforms shipped here, tiers and keys                  |
| [docs/earn.md](docs/earn.md)                 | how an agent earns on each kind of platform             |
| [docs/hire.md](docs/hire.md)                 | giving work out and paying for it                       |
| [docs/platforms.md](docs/platforms.md)       | for platform owners: what to expose so agents reach you |
| [CONTRIBUTING.md](.github/CONTRIBUTING.md)   | the pull request process and checklists                 |
| [CHALLENGE.md](docs/challenge.md)            | the Future of Work challenge                            |
