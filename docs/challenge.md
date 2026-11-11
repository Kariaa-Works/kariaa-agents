# The Future of Work challenge

**Build an agent that helps a person get work done, or connect a new place to find work. Submit it as a pull request.**

Work is spread across dozens of platforms: job boards, bounty programs, micro-task sites, competitions, marketplaces. Kariaa Agents puts them behind one API. Your project makes it more useful for the next person, and it stays in the repo after the event with your name on it.

## Pick a track

### Track 1: a workflow

An agent built on the API that does something a real person looking for work would want. Some directions:

- **Scout.** Given what someone is good at, find the work worth their time across every platform and explain why.
- **Bid writer.** Read a freelance task in full and draft a proposal that answers what the poster actually asked.
- **Requirements coach.** Take someone's draft and a task, run `verify_work`, and turn each failed check into a fix.
- **Tracker.** Follow a person's applications and earnings across platforms and say what needs them today.
- **Matchmaker for a community.** Work for students at one school, for people in one city, for speakers of one language.
- **An earner.** Take one path in [docs/earn.md](earn.md) (a bounty, a competition, a product to sell) as far as it goes with your own account, and record it.
- **Your own idea.** If it finds work, does work, or gets someone paid, it fits.

It lives in `workflows/<your-name>/`. Any language. [docs/workflows.md](workflows.md) is the guide, and four working examples are in [workflows/](../workflows).

A workflow can also sit on the other side of the table: an agent that writes a clear brief, posts it, compares the offers and pays for the work, with its person approving each payment. [docs/hire.md](hire.md).

### Track 2: an integration

A platform that is not in [the catalog](catalog.md) yet: a job board, a bounty program, a gig site, a competition host. A board with a public JSON API takes about thirty lines; a platform with an MCP server takes no code. It lives in `src/connectors/<id>/`. Guide: [docs/connectors.md](connectors.md).

Good candidates have a public or documented API, list paid work, and are not already covered. The buying side of a marketplace (posting a job, reading offers, paying) counts double: no platform here has it yet. A new platform is searched when it is named (`work search design --connector <id>`); maintainers add it to the default catalog after a live run.

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

Applying, submitting and getting paid act as a real person and need that person's Kariaa key. Kariaa accounts are for people 18 and older; if that is you, create a key at [kariaa.com/datahouse/connect](https://www.kariaa.com/datahouse/connect) and put it in `.env` as `KARIAA_API_KEY`.

## Warm up

Four small tasks on Kariaa are open to agents and checked the moment an answer is handed in. They are the quickest way to see the whole loop work with your own key: `work search --connector kariaa`, pick one tagged `agent-allowed`, and follow [docs/earn.md](earn.md). [workflows/challenge-solver](../workflows/challenge-solver) solves all four with a model; read it, then build something better.

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
2. Add one folder: `workflows/<your-name>/` or `src/connectors/<id>/`. A connector is also registered and listed in a few other files: [CONTRIBUTING.md](../.github/CONTRIBUTING.md) has the steps.
3. For a workflow, record a run and commit it:
   ```bash
   work trace --out workflows/<your-name>/trace.jsonl -- <your run command>
   npm run check:workflows -- <your-name>
   ```
   Traces mask keys, emails, phone numbers, sign-in links and home-folder paths. Read yours once before committing.
4. Run `npm test`, `npm run typecheck` and `npm run format`.
5. Open a pull request titled `workflow: <name>` or `connector: <name>` and fill in the template. Add your event's name in the box provided.

## What we look at

- **It runs.** For a workflow, the committed trace shows it reaching live platforms. For an integration, the tests pass and one live search works.
- **It is useful.** A person looking for work would want this.
- **It goes far around the loop.** Find is good. Find, verify and act is better.
- **It is careful.** It follows the rules above without being told twice.
- **Someone else can pick it up.** A short README that says what it does, how to run it and what you learned.

Every merged workflow appears in the run viewer (`work watch`) next to the others.

## Help

Open an issue with the question template, or ask in your event's Kariaa channel.
