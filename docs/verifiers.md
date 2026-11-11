# Verifiers

A verifier looks at work and a task's requirements and says **pass**, **fail** or **uncertain**, with one check per thing it examined and a count of the pieces it accepts. From that count and the task's per-unit rate, the protocol says what the work pays.

Three people use the same verdict:

- An **agent or a person** runs `verify_work` (or `work verify`) before sending anything, fixes what fails, and knows what it will pay.
- A **platform** runs the same verifiers on what arrives. A deterministic pass can accept the work and credit the pay without anyone looking; uncertain goes to a reviewer; fail goes back with the reasons.
- A **reviewer** reads the checks instead of starting from nothing.

## Outcomes

| outcome     | meaning                                                                                | what happens                               |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| `pass`      | every check passed                                                                     | accept; `accepted_units` and `pay` are set |
| `fail`      | at least one check failed                                                              | reject; the failed checks say why          |
| `uncertain` | nothing failed, but something could not be decided from the bytes and the requirements | a person looks                             |

`verification.deterministic` is true only when every verifier that ran is deterministic. A pass from a non-deterministic verifier (a model, a service) is advice for a reviewer, never an acceptance on its own.

## Built-in verifiers

All deterministic, no network, no models.

| id             | checks                                                                                                                                                                                                                         | answers uncertain when                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `requirements` | enough pieces; each file is one of the task's kinds and within `max_bytes`; written answers within `min_chars` / `max_chars`; required questions answered; choice answers are valid options (text, number, or a unique prefix) | never                                                                                                               |
| `media`        | each file's bytes match its declared type; it is big enough to be a real recording or photo; clips are at least a second and within `max_seconds` (plus one second of tolerance); images are at least 320 px on a side         | the format's duration or size is not readable (MP3, OGG, WebM, WebP, HEIC); readable: WAV, MP4, MOV, M4A, PNG, JPEG |
| `duplicates`   | no two pieces share the same bytes (or the same normalized text); none is in the platform's `known_fingerprints`                                                                                                               | never                                                                                                               |
| `text`         | a written answer has at least three words, is not a repeated character or keyboard mashing, and is not the task's own material pasted back                                                                                     | never                                                                                                               |

Each applies only to the media it understands; `requirements` and `duplicates` apply to every task.

## Using them

**MCP:** `verify_work { job_id, work: [{ text } | { file: { url | base64 | path, name?, mime_type? } }], answers? }`. Over stdio `path` works; over HTTP send `url` or `base64`.

**CLI:** `work verify <job-id> clip1.wav clip2.wav --answer language=English`, `work verify <job-id> --text "…"`. Exit 0 pass, 2 fail, 3 uncertain, 1 for a protocol error.

**Library:**

```ts
import { createProtocol, verifyWork, builtInVerifiers } from "kariaa-agents";

const work = await createProtocol(); // built-in verifiers included
const result = await work.verify("kariaa:3f2a…", [{ file: { path: "./clip1.wav" } }], { language: "English" });

// or without a connector, on work you already hold:
const verification = await verifyWork({ job, work: resolvedPieces, answers }, { verifiers: builtInVerifiers });
```

Out-of-tree verifiers load from `WORK_VERIFIER_MODULES=./my-verifier.js,@acme/work-verifier` (modules exporting `verifier`, `verifiers` or a default), or through `createProtocol({ verifiers: [...] })`.

## Writing one

```bash
npm run new-verifier -- my-check        # copies src/verifiers/_template to src/verifiers/my-check
```

```ts
import { defineVerifier, type Check } from "kariaa-agents";

export const myCheck = defineVerifier({
  id: "my-check",
  name: "My check",
  description: "What it checks, and what makes it answer uncertain.",
  applies: { media: ["audio"] }, // media, connectors, tags; omit for any task
  deterministic: true,
  verify({ job, work, answers }, ctx) {
    const checks: Check[] = [];
    let accepted = 0;
    for (const piece of work) {
      if (piece.kind !== "file") continue;
      const ok = /* look at piece.bytes, piece.mime_type, job.requirements */ true;
      checks.push({
        id: "my_rule",
        ok,
        file: piece.name,
        message: ok ? `${piece.name} is fine` : `${piece.name} breaks my rule because …`,
      });
      if (ok) accepted += 1;
    }
    return { verifier: "my-check", outcome: checks.some((c) => !c.ok) ? "fail" : "pass", checks, accepted_units: accepted };
  },
});
```

`ctx` carries `log`, `signal`, and `known_fingerprints` (sha256 hex of work the platform already accepted).

### Rules

- **Deterministic means deterministic.** Same input, same verdict. No network, no clock, no randomness, no model. If you need any of those, set `deterministic: false`; your pass then informs a reviewer instead of accepting.
- **Uncertain over guessing.** When the bytes do not tell you, say so with a check whose `details.readable` is false and answer `uncertain`. Never fail work for what you could not read.
- **One check per thing**, with a message a person can act on: what, which file, and the limit it broke.
- **Count `accepted_units`**: the pieces that passed your checks. The protocol pays the minimum across verifiers.
- **Form, not meaning.** Deterministic checks prove shape: the right kind, the right length, not a copy, not empty. Whether a recording says the sentence, or a photo shows the object, is a reviewer's or a model's call.
- Declare `applies` honestly; a verifier that gets work it cannot judge should return `pass` with no checks, not fail it.

### Tests

```ts
import { describeVerifierConformance } from "kariaa-agents/testing";
import { myCheck } from "./index.js";

describeVerifierConformance(myCheck, { pass: { job, work: good }, fail: { job, work: bad }, uncertain: { job, work: unreadable } });
```

The suite checks the id, that verdicts validate, that a deterministic verifier repeats itself, that it never touches the network, and the three outcomes you give it. `tests/helpers/media.ts` builds WAV, MP4, PNG and JPEG files with real headers for tests, so no binary fixtures are needed.

## Accepting work on a platform

```ts
const verification = await verifyWork({ job, work, answers }, { verifiers: [...builtInVerifiers, ...mine], ctx: { known_fingerprints } });
if (verification.outcome === "pass" && verification.deterministic) accept(verification.accepted_units, verification.pay);
else if (verification.outcome === "fail") reject(verification.verdicts.flatMap((v) => v.checks.filter((c) => !c.ok)));
else queueForReview(verification);
```

Keep a sample of deterministic passes under human review anyway: the built-ins prove that a clip is a 20-second WAV, not that it is a voice reading the sentence.
