# The catalog

The platforms that ship with this repo. It is a short list on purpose: one or two of each kind, each a working example to copy. Everything else arrives by pull request ([connectors.md](connectors.md)).

Each platform is a folder under `src/connectors/` with its own README: what the platform offers, which steps work through its API, and how its auth works.

| platform                                                   | kind        | what an agent can do through the API                                                  | key                                                                              |
| ---------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`kariaa`](../src/connectors/kariaa)                       | micro tasks | find, apply, add work, submit, track, earnings, payout                                | `KARIAA_API_KEY` to act; reading needs none                                      |
| [`kariaa-jobs`](../src/connectors/kariaa)                  | jobs        | find and read job listings                                                            | none (a `KARIAA_API_KEY` raises the search limit)                                |
| [`opentask`](../src/connectors/opentask)                   | bounties    | find, bid, deliver, submit, track, earnings                                           | `OPENTASK_API_TOKEN` to act                                                      |
| [`near-agent-market`](../src/connectors/near-agent-market) | bounties    | find, bid, deliver, submit; an agent account can be registered through the API        | `NEAR_AGENT_MARKET_TOKEN`                                                        |
| [`superteam-earn`](../src/connectors/superteam-earn)       | bounties    | find, submit work to a listing, track; an agent account can be registered             | made by `work connect superteam-earn`                                            |
| [`algora`](../src/connectors/algora)                       | bounties    | find and read open-source bounties; the attempt and the claim are made on GitHub      | `GITHUB_TOKEN` (also lifts the anonymous limit)                                  |
| [`opire`](../src/connectors/opire)                         | bounties    | find and read cash rewards on GitHub issues; the fix and the claim are made on GitHub | none                                                                             |
| [`whop-bounties`](../src/connectors/whop-bounties)         | micro tasks | find brand bounties, submit content, earnings, payout                                 | `WHOP_OAUTH_TOKEN`                                                               |
| [`kaggle`](../src/connectors/kaggle)                       | competition | find competitions, upload a submission, read the score                                | `KAGGLE_USERNAME`, `KAGGLE_KEY`                                                  |
| [`yeswehack`](../src/connectors/yeswehack)                 | bug bounty  | find and read programs, scopes and reward tables                                      | none                                                                             |
| [`printify`](../src/connectors/printify)                   | selling     | draft a product, upload a design, publish with a confirm token, read orders           | `PRINTIFY_API_TOKEN` (and `PRINTIFY_SHOP_ID` when the account has several shops) |
| [`remotive`](../src/connectors/remotive)                   | jobs        | find and read remote job listings (the smallest connector: start here)                | none                                                                             |
| [`dice`](../src/connectors/dice)                           | jobs        | find and read tech jobs through Dice's MCP server (the example of a linked server)    | none                                                                             |

`work connectors` shows the same list with which keys are set. `work connect <platform>` says what a platform needs.

## Which platforms a search asks

A search that names no platform asks the ones with a **tier**:

| tier         | what the agent can do                                                                                      | platforms                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **managed**  | every step; `work connect` can create the account for the person                                           | `kariaa`, `near-agent-market`, `superteam-earn` |
| **self**     | every step, once the person links their own account                                                        | `kaggle`, `whop-bounties`                       |
| **discover** | find and read; an action answers `handoff_required` with the link and what the person does on the platform | `algora`, `yeswehack`                           |

`algora` joins these searches once `GITHUB_TOKEN` is set: without one it shares GitHub's anonymous limit with everyone on the same network.

A platform without a tier is asked when it is named: `work search design --connector remotive`, or `connectors: ["remotive"]` in code. `WORK_CATALOG=all` asks every platform on every search.

A new connector starts without a tier. A maintainer gives it one after it has been run live: the API does what the README says, the platform's terms allow it, and the work on it is real and paid.

## Adding a platform

- A board with a JSON API: copy [`remotive`](../src/connectors/remotive), about thirty lines.
- A platform with an MCP server: copy [`dice`](../src/connectors/dice), a declarative profile and no code ([mcp-profiles.md](mcp-profiles.md)).
- A platform where an agent applies, delivers and gets paid: read [`opentask`](../src/connectors/opentask) and [`kariaa`](../src/connectors/kariaa).
- A platform that sells: read [`printify`](../src/connectors/printify), including how a confirm token keeps anything from going live by accident.

# Verifiers

Deterministic checks that say whether a piece of work meets a job's requirements before it is sent. They run on your machine and send nothing.

| verifier       | what it checks                                                                    |
| -------------- | --------------------------------------------------------------------------------- |
| `requirements` | enough pieces, the right kinds, sizes within limits, required questions answered  |
| `media`        | the bytes match the file type, clips are within length, images are not thumbnails |
| `duplicates`   | no piece repeated, nothing already accepted                                       |
| `text`         | real words, not keyboard mashing, not the task material pasted back               |

`work verify <job> <files…>` exits 0 on pass, 2 on fail, 3 on uncertain. [verifiers.md](verifiers.md) has the contract and how to add one.
