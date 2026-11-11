# The protocol

## Nouns

**Job**: anything you can find.

- `kind: "task"`: work done and submitted through the protocol.
- `kind: "listing"`: a posting you apply to elsewhere; `url` and `apply_hint` say where.

**Application**: your relationship with one job, from applying to the review outcome.

**Earnings** and **Payout**: what accepted work has paid, and the money leaving the platform.

All are defined as zod schemas in `src/core/types.ts`; the TypeScript types derive from them.

```ts
type Job = {
  id: string; // "<connector>:<native id>"
  connector: string;
  kind: "task" | "listing";
  title: string;
  org?: string; // company, program, employer
  location?: { text?: string; country?: string; remote?: boolean };
  pay?: {
    min?: number;
    max?: number;
    currency?: string;
    period?: "hour" | "day" | "week" | "month" | "year" | "unit";
    unit?: string;
    text?: string;
  };
  summary?: string;
  description?: string;
  instructions?: string; // the task's own material: sentences to read, answers to rate
  url?: string;
  posted_at?: string;
  expires_at?: string;
  tags?: string[];
  stages: Stage[]; // what you can do with this job here
  apply_hint?: string;
  requirements?: {
    questions?: {
      id: string;
      question: string;
      type: "text" | "select" | "multiselect" | "url_list";
      options?: string[] | null;
      required?: boolean;
    }[];
    files?: { kinds: string[]; count?: number; max_seconds?: number; max_bytes?: number };
    text?: { min_chars?: number; max_chars?: number };
    how_to?: string[];
    looks_like?: string;
    rules?: string[];
  };
  raw?: unknown;
};

type Application = {
  id: string; // "<connector>:<native id>"
  job_id: string;
  connector: string;
  job_title?: string;
  stage: "applied" | "work_needed" | "in_review" | "accepted" | "rejected" | "withdrawn" | "closed";
  files?: { id: string; name: string; kind: string; size?: number }[];
  progress?: { received: number; wanted: number; ready_to_submit: boolean };
  next?: string; // what to do next, in words
  url?: string;
  created_at?: string;
  updated_at?: string;
  review?: { note?: string; earned?: { amount: number; currency: string } };
  raw?: unknown;
};
```

```ts
type Earnings = {
  connector: string;
  balance: Money; // available to pay out
  total_earned?: Money;
  pending?: Money; // accepted but not yet credited
  entries?: {
    id: string;
    application_id?: string;
    job_title?: string;
    amount: number;
    currency: string;
    status: "pending" | "available" | "paid";
    earned_at?: string;
    note?: string;
  }[];
  payouts?: Payout[];
  min_payout?: Money;
  methods?: string[]; // "paypal", "venmo", "bank", "giftcard"…
  help?: string;
};

type Payout = {
  id: string; // "<connector>:<native id>"
  connector: string;
  amount: Money;
  method: string;
  destination?: string;
  status: "requested" | "paid" | "rejected" | "cancelled";
  requested_at?: string;
  paid_at?: string;
  note?: string;
  raw?: unknown;
};

type Money = { amount: number; currency: string };
```

### Application stages

| stage         | meaning                                             |
| ------------- | --------------------------------------------------- |
| `applied`     | accepted; waiting for the source to unlock the work |
| `work_needed` | send the work now (`upload`), then `submit`         |
| `in_review`   | submitted; the source is reviewing                  |
| `accepted`    | approved; `review.earned` when money is involved    |
| `rejected`    | not approved; `review.note` says why                |
| `withdrawn`   | taken back                                          |
| `closed`      | over for another reason                             |

Some sources take an interest rather than an application: Kaggle wants the rules accepted on its site. Their `apply` answers `applied` with `next` saying what finishes it and `url` pointing there. A source with no apply tool but a submit tool answers `work_needed` at once, without calling anything, because taking the work is the submission.

## Ids

Every published id is `<connector id>:<native id>`: `kariaa:3f2a…`, `remotive:1923456`, `opentask:cml8tie2g0001…`. The native part may itself contain colons; the split is at the first one. Connectors never see the prefix: the router strips it on the way in and adds it to `id` and `job_id` on the way out.

File ids (`Application.files[].id`) are never prefixed. They only mean something together with their application.

## Stages

A connector supports a stage by implementing its method; nothing is declared twice.

| stage      | method                                        | does                                                                                           |
| ---------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `search`   | `search(query, ctx)`                          | find jobs                                                                                      |
| `get`      | `get(id, ctx)`                                | one job in full                                                                                |
| `apply`    | `apply(id, input, ctx)`                       | start an application                                                                           |
| `upload`   | `upload(appId, work, ctx)`                    | add one piece of work (text or a file)                                                         |
| `remove`   | `remove(appId, fileId, ctx)`                  | take one back                                                                                  |
| `submit`   | `submit(appId, input, ctx)`                   | hand the work in                                                                               |
| `status`   | `status(appId, ctx)`                          | where an application stands                                                                    |
| `list`     | `list(ctx)`                                   | the person's applications                                                                      |
| `link`     | `link(appId, ctx)`                            | a web link to finish in a browser                                                              |
| `account`  | `account(ctx)` / `updateAccount(fields, ctx)` | who is signed in; profile readiness                                                            |
| `earnings` | `earnings(ctx)`                               | balance, credits for accepted work, payouts so far, how a payout works                         |
| `payout`   | `payout(input, ctx)`                          | request money: `{ amount?, method, destination?, note? }`; no `amount` means the whole balance |

A job's own `stages` can narrow the connector's (a closed task drops `apply`). A listing from a find-only board has an empty `stages` and an `apply_hint`. `search`, `list`, `account`, `earnings` and `payout` belong to the account, so they never appear in a job's `stages`.

## Search

`search({ query?, location?, remote?, kind?, category?, media?, pay_min?, currency?, direct_apply?, fiat_only?, posted_after?, connectors?, exclude_connectors?, limit?, cursor? })` fans out to every connector that can search, each under its own time budget (`WORK_SEARCH_TIMEOUT_MS`, default 40 s). Results interleave connector by connector, so a source with many rows cannot crowd out the others; duplicates by URL are dropped; `limit` (default 20, max 50) caps the list and `more` says there was more. Connectors that failed or timed out are listed in `partial`, never thrown.

**An empty query means "work available now"**: only connectors that offer tasks are asked, unless `connectors` names the sources.

Every job seen is kept in a cache (500 entries, 7 days, `WORK_CACHE_DIR`), so `get` works for listings from boards that have no by-id endpoint, and so a later CLI process still knows an id.

## Errors

One error type, `ProtocolError { code, message, connector?, details?, retry_after? }`:

| code             | meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `not_supported`  | the connector or job does not offer this stage; `details.apply_hint` for listings |
| `not_found`      | no such job, application or connector                                             |
| `auth_required`  | set the connector's credential first; the message says where to get it            |
| `rate_limited`   | try again after `retry_after` seconds                                             |
| `invalid_input`  | the input is wrong; `details` says how (missing question ids, allowed kinds)      |
| `not_ready`      | do something first: complete the profile, add more work                           |
| `wrong_stage`    | too late or not yet unlocked; `details.stage`                                     |
| `already_exists` | already there; for a duplicate file, `details` names the existing one             |
| `timeout`        | the source did not answer in time                                                 |
| `upstream_error` | the source failed                                                                 |

MCP tools return errors as results (`isError: true`) with `structuredContent: { error, message, connector?, retry_after?, details? }`. The CLI prints `code: message` and exits 1, or the same JSON with `--json`.

## Idempotency

| stage                                                | repeat behaviour                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `search`, `get`, `status`, `list`, `link`, `account` | pure                                                                                                                                    |
| `apply`                                              | returns the existing application                                                                                                        |
| `upload`                                             | not idempotent; the same content again answers `already_exists` (treat as done)                                                         |
| `remove`                                             | `not_found` on repeat                                                                                                                   |
| `submit`                                             | returns the current application                                                                                                         |
| `earnings`                                           | pure                                                                                                                                    |
| `payout`                                             | not idempotent; a second request while one is open answers `already_exists`; below the minimum or above the balance answers `not_ready` |

## Verification

`verifyWork({ job, work, answers }, { verifiers })` runs every applicable verifier over the pieces before they are sent (or when they arrive at a platform) and combines the verdicts: fail beats uncertain beats pass. A pass carries `accepted_units` and `pay` from the task's per-unit rate; `deterministic` says whether every verifier that ran is deterministic, which is the condition for accepting work without a person. See [verifiers.md](verifiers.md).

## Work input

`upload` takes exactly one of:

- `text`: a written answer.
- `file.path`: a file on disk, only where the host allows it (the CLI and the stdio MCP server).
- `file.url`: a public https URL; redirects are not followed and private addresses are refused.
- `file.base64`: the bytes, with `file.name`.

The media type is taken from `file.mime_type`, else sniffed from the bytes, else from the extension. The size limit is 100 MB (`WORK_MAX_FILE_BYTES`).

## Giving work out

The buying side has its own nouns and stages. [hire.md](hire.md) walks through it.

- **Posting**: a job you posted. `{ id, connector, title, status, budget?, funded?, offers?, awarded_offer?, url?, next? }` with `status` one of `draft`, `open`, `assigned`, `in_review`, `completed`, `cancelled`. Its id is `<connector>:<native id>` like every other id.
- **Offer**: a bid, application or entry on a posting. `{ id, from: { name?, id?, kind?, rating?, url? }, amount?, days?, note?, status, delivery? }` with `status` one of `pending`, `awarded`, `delivered`, `accepted`, `rejected`, `withdrawn`. An offer id only means something together with its posting.
- **Payment**: what a `pay` call did. `{ status, action?, amount?, to?, fee?, confirm?, next? }` with `status` one of `confirm_needed`, `funded`, `released`, `pending`, `refunded`, `failed`.

| stage      | method                                                   | what it does                                                           |
| ---------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `post`     | `post(connector, input)`                                 | posts a job; charges nothing                                           |
| `postings` | `postings(connector?)`                                   | the jobs you posted                                                    |
| `offers`   | `offers(postingId)`                                      | one posting and the offers on it                                       |
| `award`    | `award(postingId, offerId)`                              | gives the work to one offer                                            |
| `review`   | `review(postingId, { decision, note? })`                 | accept, request changes or reject; a note is required unless accepting |
| `pay`      | `pay(postingId, { action?, offer?, amount?, confirm? })` | sets money aside (`fund`) or hands it over (`release`)                 |
| `cancel`   | `cancelPosting(postingId)`                               | closes a posting; `next` says what happens to money set aside          |

`pay` is two calls. Without `confirm` it moves nothing and answers `confirm_needed` with the terms and a token signed for the posting, the offer, the action, the amount, the fee and the receiver, good for fifteen minutes. With that token it carries the payment out. A token for different terms, an expired one or a missing one all get the same answer: `confirm_needed` and a fresh token. Where the platform does not report what is owed, `pay` needs the amount.
