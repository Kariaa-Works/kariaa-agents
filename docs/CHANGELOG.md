# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Search and read output marks a task an agent may do with `agent-allowed`; an empty search names the platforms left out for want of a key; `work me` with no key says which key to set.
- The pull request check accepts a `docs/CHANGELOG.md` line in a workflow pull request, and holds a new connector until it is registered, listed in `docs/catalog.md`, described, and no longer set to `live: false`.
- Giving work out: `post`, `postings`, `offers`, `award`, `review`, `pay` and `cancel` on the connector contract, the router, the MCP server (`post_job`, `my_postings`, `list_offers`, `award_offer`, `review_work`, `pay_for_work`, `cancel_posting`) and the command line. `pay` always takes a confirm step. `describeBuyerConformance` and `docs/hire.md` for connector authors.
- Workflows: agents built on the API, one folder each under `workflows/`, with `npm run new-workflow`, examples (`scout`, `bounty-brief` in Python, `openai-agent`, `challenge-solver`) and `npm run check:workflows`.
- `work trace -- <command>` records every call a workflow makes, from any language, with keys and personal details masked; `traceProtocol`, `readTrace` and `summarizeTrace` in the library.
- `work watch`: a local page that follows a run live and replays recorded ones; `--export` writes it as static files.
- `CHALLENGE.md` for the Future of Work challenge and `docs/workflows.md`.
- Eleven platforms (twelve connectors: Kariaa has two), one or two of each kind, each a working example to copy: `kariaa` and `kariaa-jobs`, `opentask`, `near-agent-market`, `superteam-earn`, `algora`, `whop-bounties`, `kaggle`, `yeswehack`, `printify`, `remotive`, `dice`. See `docs/catalog.md`.

- The protocol: `Job`, `Application`, `Earnings`, `Payout`, stages (`search`, `get`, `apply`, `upload`, `remove`, `submit`, `status`, `list`, `link`, `account`, `earnings`, `payout`), ids `<connector>:<native id>`, typed errors.
- `defineJsonBoard` for boards with a JSON API; out-of-tree connectors through `WORK_CONNECTOR_MODULES`.
- Verifiers: deterministic checks that decide whether work is complete and what it pays (`requirements`, `media`, `duplicates`, `text`); `verify_work` tool and `work verify` command; out-of-tree verifiers through `WORK_VERIFIER_MODULES`.
- MCP server over stdio and Streamable HTTP with 24 tools, a guide resource and a `find-work` prompt.
- The `work` command line with `--json` on every command.
- Conformance suites for connectors and verifiers, a fake Kariaa server and synthetic media for tests.
- Linked MCP servers: `defineMcpConnector` with declarative profiles (`src/core/mcp/`), a shared `McpClientPool`, OAuth sign-in (`work login`, `work logout`), `work mcp inspect`, `work mcp call`, `work draft`, and `tests/helpers/fakeMcpServer.ts` for tests.
- `fetchJson` for REST connectors.
- `docs/platforms.md` for platform owners and `docs/mcp-profiles.md` for the profile language.
- `optIn` on connectors: sources that start a local process or read a chain are searched only when named.
- `defineFeedBoard` and `parseFeed` for RSS, Atom and XML feeds; `defineJsonBoard` takes `kinds`, `optIn`, and request objects with a method, body and headers, and answers `auth_required` when a key is refused.

### Changed

- Licensed under Apache 2.0.
- The package is named `kariaa-agents`; the command is still `work`.

### Removed

- Forty connectors that had not been run live, and MoltJobs. A platform returns by pull request after a real run.
