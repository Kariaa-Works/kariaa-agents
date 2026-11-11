# Contributing

Three kinds of contribution make this repo more useful, and all arrive as pull requests from a fork:

- **Workflows**: an agent built on the API that does something for a person, in `workflows/<name>/`. Guide: [docs/workflows.md](../docs/workflows.md).
- **Connectors** (integrations): a new source of work, in `src/connectors/<id>/`. Guide: [docs/connectors.md](../docs/connectors.md).
- **Verifiers**: a deterministic check that decides whether work is complete and what it pays, in `src/verifiers/<id>/`. Guide: [docs/verifiers.md](../docs/verifiers.md).

Building with a coding agent? [AGENTS.md](../AGENTS.md) has the layout, the commands, the rules and the usual mistakes on one page.

Changes to the core (`src/core`), the MCP server or the CLI are welcome too; open an issue first for anything that changes the protocol's shapes or error codes, since every connector, verifier and client depends on them.

## Setup

```bash
git clone <your fork>
cd kariaa-agents
npm install
npm test              # unit and contract tests, no network
npm run typecheck
npm run build
npm run format        # prettier
```

Node 20 or newer. TypeScript, ESM, imports with `.js` suffixes, formatted by Prettier (`npm run format:check` runs in CI).

## Adding a workflow

1. `npm run new-workflow -- <name>` copies the template. Any language works; see `workflows/bounty-brief` for Python.
2. Write the workflow. Keep keys in `.env`, cap writes per run, and call `verify` before anything is sent.
3. Fill in `workflow.json` and the folder's `README.md`.
4. Record a run and commit it: `work trace --out workflows/<name>/trace.jsonl -- <run command>`. Look at it with `work watch`.
5. `npm run check:workflows -- <name>` must pass.

Rules: follow each job's own rules; no bulk applying; nothing invented about the person; no secrets in the folder; under 2 MB. A workflow touches only its own folder, plus its line in `docs/CHANGELOG.md`.

## Adding a connector

1. `npm run new-connector -- <id>` copies the template.
2. A board with a JSON search API: fill in `request`, `rows` and `map`. A richer source: implement the `Connector` methods you support (`apply`, `upload`, `submit`, `status`, `earnings`, `payout`…).
3. Capture one real response, trim it to three rows, save it as `src/connectors/<id>/fixtures/search.json` (make the folder), and load it in `index.test.ts` in place of the inline example. Remove `live: false` from the test once the connector points at the real API.
4. Register it in `src/connectors/index.ts`: the import, the `builtInConnectors` list and the `export { … }` block.
5. `npm test` must pass. Run the folder once against the network: `npm run test:live -- src/connectors/<id>`. Then `npm run build` and search it by name: `work search <word> --connector <id>`. A connector joins searches that name no connector once a maintainer gives it a `tier` after a live run.
6. Write the folder's `README.md` (coverage, stages, keys, the source's credit terms), add a row to the table in `docs/catalog.md` (copy a row of the same kind), and list any key in `.env.example`.

A platform with an MCP server is linked without code: `work draft https://their.server/mcp --query developer --out src/connectors` writes `profile.ts` and `index.ts`; finish the TODOs, capture trimmed read fixtures with `work mcp call`, and test on `createFakeMcp` ([docs/mcp-profiles.md](../docs/mcp-profiles.md)). Never run a platform's write tools from tests or smoke runs.

Rules: public or documented APIs only; no scraping against a site's terms; keyless where possible; credit the source as it asks; honour `ctx.signal`; use `ctx.fetch`; never log credentials; nothing that costs money per call.

The buying side of a marketplace (posting a job, reading offers, paying) is part of the same connector: [docs/hire.md](../docs/hire.md). Never call a platform's posting or payment endpoints from a test; use recorded responses, and the platform's sandbox when you try it by hand.

## Adding a verifier

1. `npm run new-verifier -- <id>` copies the template.
2. Implement `verify`: one check per thing examined, `accepted_units` for the pieces that passed, `uncertain` when the bytes do not tell you.
3. Declare `applies` (media, connectors, tags) and `deterministic` honestly. Built-ins must be deterministic: no network, no clock, no randomness, no model.
4. Add `index.test.ts` with `describeVerifierConformance` and a pass, a fail and, where it applies, an uncertain input. Build test media with `tests/helpers/media.ts`.
5. Register it in `src/verifiers/index.ts` and describe it in `docs/verifiers.md`.

## Pull requests

- Use the pull request template; it carries the checklist for each kind of change.
- Tests for what changed, with fixtures or synthetic data rather than network calls.
- `npm test`, `npm run typecheck`, `npm run build` and `npm run format:check` pass (CI runs them on Node 20 and 22).
- Docs updated where behaviour changed; a line in `docs/CHANGELOG.md` under Unreleased.
- One workflow, connector or verifier per pull request.

## Where things live

- `src/core`: the model (`types.ts`), the connector contract (`connector.ts`), the verifier contract (`verifier.ts`), the router (`router.ts`), file handling (`files.ts`), media parsing (`media.ts`), the board helper (`jsonBoard.ts`), the conformance suites (`conformance.ts`).
- `src/connectors/<id>` and `src/verifiers/<id>`: one folder each, with `index.ts`, `index.test.ts`, `README.md` (connectors) and fixtures.
- `src/mcp`: the MCP server, stdio and HTTP entry points. `src/cli`: the `work` command.
- `workflows/<name>`: one folder per workflow. `viz`: the page `work watch` serves. `src/core/trace.ts`: run recording.
- `tests`: router, files, cache, registry, verification, MCP, HTTP and CLI tests, with fake connectors, a fake Kariaa server and synthetic media under `tests/helpers`.

## Reporting problems

Bugs and proposals go through the issue templates. Security reports do not: see [SECURITY.md](SECURITY.md).
