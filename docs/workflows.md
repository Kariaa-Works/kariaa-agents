# Workflows

A workflow is an agent that uses the Work API to do something for a person: find work that fits them, check a draft against a job's requirements, apply, send the work in, follow it to payment. Each one is a folder under `workflows/`, added by pull request.

## A workflow folder

```
workflows/my-workflow/
  workflow.json     what it is and how to run it
  README.md         what it does, how to run it, what you learned
  run.ts            the code (any language, any file names)
  trace.jsonl       one recorded run
```

Start one with `npm run new-workflow -- my-workflow`.

### workflow.json

```json
{
  "name": "my-workflow",
  "title": "My workflow",
  "team": "Team name or your name",
  "description": "One sentence: what it finds and what it does with it.",
  "language": "typescript",
  "interface": "library",
  "run": "npx tsx workflows/my-workflow/run.ts",
  "steps": ["find", "verify", "apply"],
  "needs_key": false,
  "env": ["KARIAA_API_KEY (optional: applying)"]
}
```

`name` is the folder name. `steps` lists the parts of the loop the workflow reaches: `find`, `apply`, `do`, `verify`, `submit`, `track`, `paid`. `interface` is `library`, `mcp` or `cli`. `language` is what it is written in (`typescript`, `python`, anything). `needs_key` is `true` when it cannot run at all without a key. `env` names every variable it reads, so someone else can run it.

## Three ways to call the API

### The library (TypeScript)

```ts
import { createProtocol, ProtocolError } from "../../src/index.js";

const work = await createProtocol(); // reads keys from .env
try {
  const found = await work.search({ query: "transcription", kind: "task", limit: 10 });
  const first = found.jobs[0];
  if (first) {
    const job = await work.get(first.id);
    // …
  }
  // …
} finally {
  await work.close();
}
```

[workflows/scout/run.ts](../workflows/scout/run.ts) is a complete example. The methods are `search`, `get`, `resolve`, `verify`, `apply`, `upload`, `remove`, `submit`, `status`, `list`, `link`, `accounts`, `earnings`, `requestPayout`; [protocol.md](protocol.md) has their inputs and results.

### The MCP server (any language)

`node dist/cli/index.js mcp` is an MCP server on stdio with 24 tools. Start it as a child process and speak JSON-RPC to it.

- Python with no packages: [workflows/bounty-brief/run.py](../workflows/bounty-brief/run.py) has a 40-line client you can copy.
- TypeScript with a model choosing the calls: [workflows/openai-agent](../workflows/openai-agent), on a tested loop.
- Any MCP client library works. Tools and their arguments: [mcp.md](mcp.md).

Each tool returns text for a model to read and `structuredContent` for code to read. Use `structuredContent`.

### The CLI (shell, or any language that can run a command)

Every command takes `--json`:

```bash
work search "logo design" --kind task --direct-apply --json
```

## Reading a job

`search` returns short results. `get` returns the whole job, and it is the one to act on.

- `stages` says what can be done with this job through the API. A job with only `get` is read here and finished on the platform's site (`url`, `apply_hint`). A job with `apply`, `upload` and `submit` can be done end to end.
- `requirements` says what the work must be: `questions` to answer when applying, `files` or `text` the work is made of, `rules`, `how_to`.
- `pay` says what it pays and per what.
- `apply_hint` says how this platform wants an application: which answers, in what form.

To find work an agent can act on, search with `direct_apply: true` (`--direct-apply` on the command line) or check `stages` yourself.

## Verify, then act

`verify` checks work against a job's requirements on your machine: enough pieces, the right kinds, required questions answered, text that reads as an answer. It sends nothing.

```ts
const check = await work.verify(job.id, [{ text: draft }], answers);
const problems = check.verdicts.flatMap((verdict) => verdict.checks).filter((c) => !c.ok);
for (const problem of problems) console.log(problem.message); // each one says what to fix
```

Act only when `check.outcome` is `"pass"`:

```ts
const application = await work.apply(job.id, { answers, note });
await work.upload(application.id, { text: draft }); // or { file: { path } } / { file: { url } }
const sent = await work.submit(application.id);
const now = await work.status(application.id); // applied, work_needed, in_review, accepted, rejected…
```

## Writes act as a real person

`apply`, `upload`, `submit` and `requestPayout` need a key, and they do what they say on a real platform, in front of a real reviewer.

- Read the job with `get` and follow its rules. Tasks that say no AI tools, or that ask for the person's own voice, photos or video, are not for an agent to do.
- Cap writes per run in code, and say in the README what a run can send. `scout` and `openai-agent` send nothing without a flag (`--apply`, `--act`); `challenge-solver` hands in at most four answers, to tasks marked open to agents.
- Do not put anything about the person in an application that they did not give you.
- A Kariaa key allows 60 writes a day. A `rate_limited` error means stop, not retry in a loop.

## Errors

Every failure has a code. The ones a workflow should handle:

| code                        | what it means                                        | what to do                                        |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `auth_required`             | this step needs a key that is not set                | say which key; `work connect <platform>` explains |
| `not_supported`             | this platform cannot do this step                    | check `stages` first; send the person to `url`    |
| `not_found`                 | the job closed or the id is wrong                    | drop it and move on                               |
| `invalid_input`             | an answer or file does not fit                       | read `message`; it names the field                |
| `not_ready`                 | something comes first: a fuller profile, more files  | `work me` lists what the profile is missing       |
| `wrong_stage`               | too late or not yet unlocked                         | `details.stage` says where the application is     |
| `already_exists`            | applied already, or the same file twice              | carry on with what is there                       |
| `handoff_required`          | the person finishes this step on the platform's site | `details.handoff` says where and what to do       |
| `rate_limited`              | too many calls                                       | wait; do not retry in a loop                      |
| `timeout`, `upstream_error` | the platform was slow or failed                      | carry on with the others                          |

A search across platforms does not fail because one platform did: the slow or failing ones are listed in `partial`.

## Record a run

```bash
work trace --out workflows/my-workflow/trace.jsonl -- npx tsx workflows/my-workflow/run.ts
```

`work trace` runs your command with `WORK_TRACE_FILE` set. Everything built on this repo (the library, the CLI, the MCP server) writes each call to that file: the step, the input, the result, how long it took. It works for any language because the recording happens inside the Work API, not in your code.

Traces are made to be committed. Keys, tokens, emails, phone numbers, sign-in links, home-folder paths and profile details are masked, file bytes are left out, and long text is cut. Read yours once before committing anyway.

Without `--out`, runs go to `.work/runs/`, which git ignores.

## Watch it

```bash
work watch
```

Prints an address (http://127.0.0.1:8791) to open. The page has every run: yours, each workflow's committed run, and a sample. Pick one to replay it, or start a run in another terminal and watch it live. `work watch --export site/` (git ignores `site/`) writes the page and all committed runs as static files for any web host.

## Check it

```bash
npm run check:workflows -- my-workflow
```

The same check CI runs on your pull request: `workflow.json` is filled in, there is a README without TODOs, the trace was recorded with `work trace` and reached the API, nothing in the folder looks like a key, and the folder is under 2 MB.
