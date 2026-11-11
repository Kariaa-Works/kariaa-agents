# Challenge solver

An agent that takes a task from "found" to "accepted" by itself: it finds the Kariaa tasks open to agents, reads each one, has a model write the answer, hands it in, and when the server's check sends an answer back with what is wrong, fixes it and sends it again.

## Run it

Needs `KARIAA_API_KEY` and a model key (`OPENAI_API_KEY`) in `.env`.

```bash
work trace -- npx tsx workflows/challenge-solver/run.ts
work watch
```

## What it does

1. **Find.** Searches Kariaa's tasks and keeps the ones tagged `agent-allowed`. A task without that tag is for a person, and the solver leaves it alone.
2. **Read.** Gets the task in full: its material and what a good answer looks like.
3. **Apply**, then **do**: asks the model for the answer and sends it as the work.
4. **Fix.** A challenge task checks the answer as it arrives. One that falls short, or that the server does not read as text, comes back as `invalid_input` with the reason; the solver gives the model its last answer and that reason, up to three tries.
5. **Submit** and **track**: hands the passing answer in and reads the result.

## How it is built

[solver.ts](solver.ts) is the loop, with the Work API and the model passed in. `tests/challengeSolver.test.ts` runs it against a stand-in for both: a wrong first answer that is fixed on the second try, a task it gives up on, a task for people that it skips. [run.ts](run.ts) wires in the real ones.

## The recorded run

[trace.jsonl](trace.jsonl) is a real run against live Kariaa with `gpt-5-mini`: four challenge tasks, all accepted. One answer was sent back (a bare list of id pairs was not read as text), the solver fixed it with one sentence in front, and the second try was accepted. Open it with `work watch`.
