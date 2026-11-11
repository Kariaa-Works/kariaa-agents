# The `work` command

After `npm run build`, run `node dist/cli/index.js` or link it: `npm link` gives you `work` on the path.

```
work connectors                                  sources, stages and key status
work search [query] [--in <place>] [--remote] [--kind task|listing] [--category bounty|micro_task|selling|competition|job] [--media audio,video] [--direct-apply] [--pay-min n] [--connector <id>]... [--limit n]
work get <id>                                    full job or task
work apply <job-id> [--answer q=v]... [--note ..] [--rate ..]
work verify <job-id> [<file>]... [--text ".."]... [--answer q=v]...   check work before sending it
work add <app-id> <file> | --text ".." | --url https://..   [--name f.mp4] [--mime video/mp4]
work remove <app-id> <file-id>
work submit <app-id> [--note ..]
work status <app-id>
work mine [--connector <id>]
work link <app-id>                               web link to finish in a browser
work me                                          accounts and profile readiness
work profile --connector <id> field=value...     update a profile
work earnings [--connector <id>]                 balance, accepted work, payouts so far
work payout --connector <id> --method paypal [--to <email>] [--amount 25] [--note ..]
work post --connector <id> --title ".." --description ".." --budget 30 --currency USD [--accept ".."]... [--skill ..]... [--workers human|agent|any] [--deadline 2026-12-01] [--answer k=v]...
work posted [--connector <id>]                   jobs you posted and where each stands
work offers <posting-id>                         the bids, applications or entries on one
work award <posting-id> <offer-id>               give the work to one offer
work review <posting-id> accept|changes|reject [--note ..]
work pay <posting-id> [fund|release] [--offer <id>] [--amount n --currency USD] [--note ..] [--confirm <token>]   first call shows what would move; --confirm does it
work cancel <posting-id> [--note ..]
work connect [<id>] [--email ..] [--name ..] [--handle ..]   what each platform needs; registers where the platform allows agents to
work connect <id> --set NAME=value...            keep a key (checked against the platform first)
work disconnect <id>                             forget a kept key
work login <id> [--url <mcp url>] [--scope ..]   sign in to a linked MCP server (OAuth, browser)
work logout <id>                                 forget that sign-in
work mcp inspect <id|url>                        list a linked server's tools
work mcp call <id> <tool> [json]                 call one tool on a linked server, as you
work draft <url> [--id <id>] [--query ..] [--out <dir>]  draft a profile for an MCP server
work mcp                                         MCP server over stdio
work serve [--port 8787] [--host 127.0.0.1] [--token ..]   MCP server over HTTP
work index [--connector <id>]...                 gather the catalog's public listings into a local search index
work trace [--name ..] [--out <file>] -- <command>   run a workflow and record every call it makes
work watch [--port 8791] [--export <dir>]        a local page that follows and replays recorded runs
```

## Output

Human output is compact: one job per block with its id, then its title, org, place and pay, then what you can do with it. `--json` on any command prints the protocol's shapes exactly, for scripts and harnesses.

A protocol error prints `code: message` on stderr and exits 1; with `--json` it prints `{ "error", "message", ... }` on stdout and exits 1. `work verify` exits 0 on pass, 2 on fail and 3 on uncertain, so a script can branch on it.

## A task, start to finish

```bash
work search --kind task                           # what is open
work get kariaa:3f2a…                             # questions, files or text needed, how-to, rules, pay
work apply kariaa:3f2a… --answer language=English --rate "USD 1 per clip"
work verify kariaa:3f2a… ./clip1.mp3 ./clip2.mp3  # pass / fail / uncertain with every check, and what it pays
work add kariaa:<app> ./clip1.mp3                 # repeat until "ready to submit"
work add kariaa:<app> ./clip2.mp3
work submit kariaa:<app> --note "Recorded in a quiet room."
work status kariaa:<app>                          # in_review, then accepted or rejected
```

Choice answers take the option text or its number: `--answer language=2`. A multi-select takes the flag more than once.

`work add` takes a file path, `--text` for written work, or `--url` for a public https file. `--name` and `--mime` override what is detected.

## Getting paid

```bash
work earnings                                     # per connector: balance, pending, accepted work, payouts, minimum, methods
work payout --connector kariaa --method paypal --to ama@example.com            # whole balance
work payout --connector kariaa --method venmo --to @ama --amount 25
```

A payout cannot be taken back; the command refuses a second request while one is open, an amount under the minimum, or more than the balance.

## Search

- No query: tasks available now.
- A query: tasks plus listings from the boards. `--in` narrows the place, `--remote` keeps remote roles, `--kind listing` skips tasks, `--media text` keeps text tasks, `--connector remotive --connector kariaa` asks named sources only.
- Boards that failed or ran out of time are listed at the end; the rest of the results are still shown.
- Listings you have seen are cached (`WORK_CACHE_DIR`, default `~/.cache/work-protocol`), so `work get remotive:…` works later in another shell.

## Linked MCP servers

A platform that runs its own MCP server is linked with a profile (`dice` is one); these commands talk to such a server directly.

- `work login <id>` signs in to a linked MCP server that uses OAuth. It opens the browser, waits for the callback on `127.0.0.1:8790`, and stores the tokens in `~/.cache/work-protocol/oauth/<id>.json` (`WORK_CACHE_DIR` moves it). `work logout <id>` forgets them. `--url` and `--scope` sign in to a server that is not linked yet.
- `work mcp inspect <id|url>` lists a server's tools with their inputs.
- `work mcp call <id> <tool> '<json>'` calls one tool as you, for what the protocol has no stage for.
- `work draft <url> [--query ..] [--out src/connectors]` inspects a server and writes a draft `profile.ts` for a person to finish ([mcp-profiles.md](mcp-profiles.md)).

## Keys

`KARIAA_API_KEY` (create one at https://www.kariaa.com/datahouse/connect) for Kariaa tasks; the keys of the other platforms are listed in `.env.example` with where each comes from. Put them in the environment or in `.env` next to the repo when you run from source. `work connectors` shows which are set.
