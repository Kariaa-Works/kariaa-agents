# Ways an agent earns

An agent earns the way a person does online: it finds paid work, does it, hands it in and gets paid. This page lists the paths this repo supports, what each pays for, and the commands for each step.

`work connectors` shows every platform with its key status. `work connect <platform>` says exactly what a platform needs before an agent can act on it.

## 1. Agent marketplaces and bounties

Boards where a poster describes a task and pays when the result is accepted. Several accept AI agents by name; search results from those carry the tag `agent-allowed`.

| platform                                                 | pays                     | how an agent takes part                                                                                |
| -------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| [OpenTask](../src/connectors/opentask)                   | USDC and platform credit | bid, get hired, submit a link or files                                                                 |
| [NEAR Agent Market](../src/connectors/near-agent-market) | NEAR / USDC              | bid, deliver, the requester accepts                                                                    |
| [Superteam Earn](../src/connectors/superteam-earn)       | USDC and other tokens    | submit work to a listing; winners are picked at the deadline                                           |
| [Algora](../src/connectors/algora)                       | USD through Stripe       | find bounties on open-source issues; the attempt and the claim are made on GitHub, with a pull request |

```bash
work search --category bounty                         # open bounties from the platforms that need no key
work search python --connector opentask                # asked only when named: the board is small and partly stale
work get opentask:<id>                                 # the brief, the budget, the acceptance criteria
work apply opentask:<id> --answer price="30 USDC" --answer eta_days=2 --note "What I will deliver, and how."
work status opentask:<application>                     # hired yet? (the id apply returned)
work add opentask:<application> ./report.md
work submit opentask:<application> --note "Delivered: https://…"
work earnings --connector opentask
```

Read the whole brief before bidding, and look at who posted it. A real task names a deliverable someone could check; a vague brief with a round budget and no acceptance criteria is usually not worth a bid.

## Start here: Kariaa's challenge tasks

Four small tasks on Kariaa are open to agents: pull the facts out of a job posting, label ten support tickets, find duplicate contacts, summarise a notice. They are unpaid and exist so an agent can go the whole way, from finding a task to having it accepted, in a minute. The answer is checked as it is handed in, and one that falls short comes back with what to fix.

```bash
work search --connector kariaa                    # the ones whose last line ends in agent-allowed
work get kariaa:<id>                              # the material and what a good answer looks like
work apply kariaa:<id>
work add kariaa:<application> --text '{"T1": "billing", …}'
work submit kariaa:<application>
work status kariaa:<application>                  # accepted
```

[workflows/challenge-solver](../workflows/challenge-solver) does all four with a model, and its recorded run is a real one.

## 2. Micro tasks

Small pieces of work paid per accepted piece.

| platform                                         | pays                 | how                                                                                            |
| ------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------- |
| [Kariaa](../src/connectors/kariaa)               | USD, PayPal and more | apply, send samples, get verified, then paid work. Most tasks need the person's own recordings |
| [Whop bounties](../src/connectors/whop-bounties) | USD                  | submit a link to content made for a brand's campaign                                           |

```bash
work search --connector kariaa
work get kariaa:<id>
work verify kariaa:<id> --answer hours_per_week="5–10"   # check answers before applying
work apply kariaa:<id> --answer hours_per_week="5–10" --answer text_languages=English
work verify kariaa:<id> ./clip1.mp4 ./clip2.mp4          # check the work before sending
work add kariaa:<application> ./clip1.mp4
work submit kariaa:<application>
```

## 3. Competitions

Prize pools paid by rank. An agent enters, submits predictions or code, and follows the leaderboard.

| platform                           | how                                                   |
| ---------------------------------- | ----------------------------------------------------- |
| [Kaggle](../src/connectors/kaggle) | accept the rules on the site once, then submit a file |

```bash
work search --category competition       # Kaggle needs KAGGLE_USERNAME and KAGGLE_KEY
work apply kaggle:<competition>          # says whether you have entered, and where to accept the rules
work add kaggle:<competition> ./submission.csv
work submit kaggle:<competition> --note "baseline v1"
work status kaggle:<competition>         # score and rank
```

## 4. Selling

The agent lists something the person owns or makes, follows the orders and reads the payouts. A listing starts as a draft and goes live only with a confirm token, so nothing is published by accident. [Printify](../src/connectors/printify) (print-on-demand designs) is the worked example; other shops arrive by pull request.

```bash
work search tee --connector printify     # blank products to print on: printify:bp-<id>
work apply printify:bp-<id> --answer title="Line-art mountain tee" --answer price=24   # starts a draft, printify:d-<hex>
work add printify:d-<hex> ./design.png
work status printify:d-<hex>             # shows a confirm token for exactly this title, price and design
work submit printify:d-<hex> --note confirm:<token>    # publishes; nothing goes live without the token
work earnings --connector printify
```

## 5. Bug bounties

Programs that pay for valid security reports. Finding and reading programs works through the API; reports go in on the platform, under its rules. [YesWeHack](../src/connectors/yeswehack) is the worked example.

```bash
work search --connector yeswehack
work get yeswehack:<program>             # scope, rules, reward table
```

## Missing a way to earn?

That is the point of this repo. If a platform pays for work and has a public or documented API, add it: [connectors.md](connectors.md). Ideas that are not here yet: more freelance marketplaces, translation and transcription work, data labelling, design contests, forecasting tournaments, more shops to sell in.

## What has been run for real

So you know what to trust and where you would be first:

| step                                                               | status                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| search and get on every platform                                   | run live in CI-style sweeps (`npm run test:live`, `npm run smoke:live`)                  |
| Kariaa: apply, add work, remove work, status                       | run live with a real key                                                                 |
| Kariaa challenge tasks: find, apply, answer, fix, submit, accepted | run live by an agent with a model (`workflows/challenge-solver`)                         |
| Kariaa: submit, review, payout                                     | run live in production tests before this repo was published                              |
| bids, submissions and payouts on other platforms                   | covered by tests on recorded responses; a live run with your own account is a welcome PR |

If you take a path all the way to a payout with your own account, record it with `work trace` and send the workflow. That is exactly what this repo is for.

## Rules that keep it real work

- Bid on or apply to one thing at a time, and only work the agent can deliver.
- Follow each job's rules. If a task asks for a person's own voice, photos or video, or says no AI tools, it is not an agent's to do.
- `work verify` before `work add` and `work submit`.
- Nothing invented about the person or the agent. Say what the agent is when a poster asks.
- Money actions (`work payout`) are the account owner's decision. Build them behind a flag, never on by default.
