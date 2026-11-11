## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Kind of change

- [ ] Workflow: `workflows/<name>/`
- [ ] Connector (integration): `src/connectors/<id>/`
- [ ] Verifier: `src/verifiers/<id>/`
- [ ] Core, MCP server or CLI
- [ ] Docs only

## Event

<!-- Taking part in the Future of Work challenge? Name your event and team. Otherwise delete this section. -->

## Checklist

Everyone:

- [ ] `npm test`, `npm run typecheck`, `npm run build` and `npm run format:check` pass
- [ ] Tests use fixtures or synthetic data, not the network
- [ ] Docs updated where behaviour changed; a line added under Unreleased in `docs/CHANGELOG.md`

Workflow:

- [ ] Only `workflows/<name>/` and `docs/CHANGELOG.md` are touched
- [ ] `workflow.json` and `README.md` filled in; every key it reads is listed in `env`
- [ ] `trace.jsonl` recorded with `work trace --out` and read through once (no keys, nothing personal)
- [ ] `npm run check:workflows -- <name>` passes
- [ ] Writes are capped per run in code and the README says what a run can send; `verify` runs before anything is sent; each job's own rules are followed

Connector:

- [ ] `index.ts`, `README.md`, `index.test.ts` with `describeConnectorConformance`, `fixtures/search.json` (three trimmed rows)
- [ ] Registered in `src/connectors/index.ts`; row added to `docs/catalog.md`; keys listed in `.env.example`
- [ ] Public or documented API only, credit terms followed, `ctx.fetch` and `ctx.signal` used, nothing paid per call
- [ ] `npm run test:live -- src/connectors/<id>` passed once against the real API, with `live: false` removed from the test (paste the summary line)

Verifier:

- [ ] `index.ts`, `index.test.ts` with `describeVerifierConformance` (pass, fail and, where it applies, uncertain inputs)
- [ ] Deterministic: no network, no clock, no randomness, no model (or `deterministic: false` and explained below)
- [ ] One check per thing examined, messages a person can act on, `accepted_units` counted
- [ ] Registered in `src/verifiers/index.ts`; described in `docs/verifiers.md`

## Notes for the reviewer

<!-- Anything that needs context: the API's quirks, what the verifier cannot decide, trade-offs. -->
