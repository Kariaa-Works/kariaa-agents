# The Future of Work challenge

**Build an agent that takes part in the economy, or connect a new place where agents can. Submit it as a pull request.**

Agents can already earn money, sell things, and pay people or other agents to get work done. The platforms where that happens each have their own API; Kariaa Agents puts them behind one. Your project makes it more useful for the next person, and it stays in the repo after the event with your name on it.

## Pick a track

### Track 1: a workflow

An agent built on the API. Some directions:

- **An earner.** Take one path in [docs/earn.md](earn.md) (a bounty, a competition, a data task) as far as it goes, and record it.
- **A seller.** Make something and sell it through a platform that pays the seller.
- **A buyer.** Write a clear brief, post it, compare the offers and pay for the work, with its person approving each payment. [docs/hire.md](hire.md)
- **A scout or a bid writer.** Find the work worth someone's time across every platform, or draft the proposal that answers what the poster asked.
- **A tracker.** Follow someone's applications, deliveries and earnings and say what needs them today.
- **Your own idea.** If money or work moves through it, and a person stays in control, it fits.

It lives in `workflows/<your-name>/`. Any language. [docs/workflows.md](workflows.md) is the guide, and working examples are in [workflows/](../workflows).

### Track 2: an integration

A platform that is not in [the catalog](catalog.md) yet: somewhere an agent can earn, sell or pay. A bounty program, a marketplace, a competition host, a shop, a payments API. A platform with a public JSON API takes about thirty lines; one with an MCP server takes no code. It lives in `src/connectors/<id>/`. Guide: [docs/connectors.md](connectors.md).

Good candidates have a public or documented API, involve real money, and are not already covered. The paying side of a marketplace (posting a job, reading offers, paying) counts double: no platform here has it yet. A new platform is searched when it is named (`work search design --connector <id>`); maintainers add it to the default catalog after a live run.

### Track 3: a verifier

A check that says whether a piece of work is good enough before it is sent, so an agent does not waste a person's time or leak something it should not. It lives in `src/verifiers/<id>/`. Guide: [docs/verifiers.md](verifiers.md).

### See one done

The [open pull requests](https://github.com/Kariaa-Works/kariaa-agents/pulls) include two worked examples of each track, with the checklist filled in. Copy the shape.

## Set up

```bash
git clone https://github.com/<you>/kariaa-agents   # your fork of github.com/Kariaa-Works/kariaa-agents
cd kariaa-agents
npm install
npm run build
npm link
work search "data labeling" --kind task
work trace -- npx tsx workflows/scout/run.ts
work watch
```

Without `npm link`, type `node dist/cli/index.js` in place of `work`.

Finding, reading and verifying work need no key, so everyone can build and submit.

Acting (applying, handing work in, selling, paying) happens in a real person's name and needs a key: a Kariaa key, or your own key for any platform here. Kariaa accounts are for people 18 and older; if that is you, create a key at [kariaa.com/datahouse/connect](https://www.kariaa.com/datahouse/connect) and put it in `.env` as `KARIAA_API_KEY`. `work connect` lists the keys the other platforms take.

No key? The paying side runs on a test marketplace with no account at all: `npx tsx workflows/hire-and-pay/run.ts`, once that example is merged, or `tests/helpers/fakeMarket.ts` today.

## Warm up

Four small tasks on Kariaa are open to agents and checked the moment an answer is handed in. They are the quickest way to see the whole loop work with your own key: `work search --connector kariaa`, pick one whose last line ends in `agent-allowed`, and follow [docs/earn.md](earn.md). [workflows/challenge-solver](../workflows/challenge-solver) solves all four with a model; read it, then build something better.

## Rules

1. **Real people are on the other side.** Every application and submission lands in front of a person. Apply only to work the key's owner could actually do, one job at a time. No bulk applying, no filler submissions.
2. **Follow each job's own rules.** If a task says no AI tools, or asks for the person's own voice, photos or video, an agent does not do it.
3. **Verify before you send.** Run `verify_work` and get a pass before `add_work` or `submit_work`.
4. **Nothing invented about the person.** A workflow uses what its user gave it, nothing else.
5. **No secrets in the repo.** Keys go in `.env`, which git ignores. CI rejects a pull request that contains one.
6. **Public and documented APIs only** for integrations. No scraping against a site's terms, nothing that costs money per call.
7. **Your work is open source.** Everything in a pull request is published under the repo's [Apache 2.0 license](../LICENSE).

## Submit

1. Fork the repo and make a branch.
2. Add one folder: `workflows/<your-name>/`, `src/connectors/<id>/` or `src/verifiers/<id>/`. A connector or a verifier is also registered and listed in a few other files: [CONTRIBUTING.md](../.github/CONTRIBUTING.md) has the steps.
3. For a workflow, record a run and commit it:
   ```bash
   work trace --out workflows/<your-name>/trace.jsonl -- <your run command>
   npm run check:workflows -- <your-name>
   ```
   Traces mask keys, emails, phone numbers, sign-in links and home-folder paths. Read yours once before committing.
4. Run `npm test`, `npm run typecheck` and `npm run format`.
5. Open a pull request titled `workflow: <name>`, `connector: <name>` or `verifier: <name>` and fill in the template. Add your event's name in the box provided.

## What we look at

- **It runs.** For a workflow, the committed trace shows it reaching live platforms. For an integration, the tests pass and one live search works.
- **It is useful.** Someone would want this running for them: to earn, to sell, or to get work done by paying for it.
- **It goes far around the loop.** Finding is good. Finding, checking and acting is better. Money that actually moved, with a person approving it, is best.
- **It is careful.** It follows the rules above without being told twice.
- **Someone else can pick it up.** A short README that says what it does, how to run it and what you learned.

Every merged workflow appears in the run viewer (`work watch`) next to the others.

## Help

Open an issue with the question template, or ask in your event's Kariaa channel.
