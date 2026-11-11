# OpenAI agent

Give it a goal in plain words. An OpenAI model decides which Work API tools to call, reads the results, and keeps going until the goal is met.

The loop and its guards do not depend on the model: another model needs only a small adapter like the one here.

## Run it

Needs `OPENAI_API_KEY` in `.env`. `OPENAI_MODEL` picks the model (default `gpt-5-mini`).

```bash
npm run build
work trace -- npx tsx workflows/openai-agent/run.ts "Find three paid tasks an agent could act on through the API today, read each in full, and say what each one needs."
work watch
```

By default the agent can only read: search, get, verify, and look at applications and postings. With `--act` and a `KARIAA_API_KEY` it may also apply, add work and submit, up to three writes per run. It can never pay.

## How it works

[openai.ts](openai.ts) is the only part that knows about OpenAI: it turns the loop's messages and tools into OpenAI's Chat Completions shape and the reply back into the content blocks the loop reads. No SDK, one HTTPS call per turn. To use another provider with an OpenAI-compatible API, set `OPENAI_BASE_URL`.

The loop itself, with the tool allowlist, the write cap and the refusal of local file paths, is [agent.ts](agent.ts).

## The recorded run

[trace.jsonl](trace.jsonl) is a real run with `gpt-5-mini`: twelve calls, 25 pieces of work found across three platforms, five read in full, and an answer saying what each one needs and how to apply. Open it with `work watch`.

## What we learned

- A model reads `apply_hint` and `stages` well: it told apart tasks it could finish through the API from ones that end on the platform's site without being asked to.
- It asked before acting. With read-only tools it ended by offering to prepare an application, which is the right place for a person to say yes.
- A run like this takes a couple of minutes and a few cents. The search calls, not the model, are most of the wait.
