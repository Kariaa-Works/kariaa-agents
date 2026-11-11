# Bounty brief

Finds open bounties across every platform and writes a one-page brief of what each asks for: the pay, the rules, how to take part, and whether an agent can submit through the API.

Written in Python with no packages to install, to show the Work API from a language other than TypeScript.

## Run it

```bash
npm run build                                   # once; the workflow starts the built MCP server
work trace -- python workflows/bounty-brief/run.py
work trace -- python workflows/bounty-brief/run.py --topic security
work watch
```

The brief is written to `.work/bounty-brief.md`.

## What it does

1. **Find.** `search_jobs` with `category: "bounty"`, optionally narrowed by a topic.
2. **Pick.** The first bounty from each platform, so the brief covers the field instead of one board.
3. **Read.** `get_job` for each pick, then writes down pay, rules, questions and how to take part.

## How it talks to the API

`WorkApi` in [run.py](run.py) is a complete MCP client in about 40 lines: it starts `node dist/cli/index.js mcp`, sends `initialize`, then one `tools/call` per step, and reads each tool's `structuredContent`. Copy it into any Python workflow.

## What we learned

- Bounties differ most in how you take part: some take a submission through the API, some want a bid first, and bug bounty programs only accept reports on their own site. `stages` and `apply_hint` say which, and the brief leads with it.
- Taking one bounty per platform makes a more useful page than the top ten by relevance, which often come from a single board.
