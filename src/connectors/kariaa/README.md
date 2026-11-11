# Kariaa

Two connectors on Kariaa's public MCP server at `https://agent.kariaa.com/mcp`.

## `kariaa`: DataHouse tasks

Short pieces of data work: video clips of everyday activities, photos of objects and handwriting, voice recordings in many languages, text labelling and rating. Every stage:

| stage        | Kariaa tool                                                                            |
| ------------ | -------------------------------------------------------------------------------------- |
| search       | `list_tasks`, filtered here by words and `media`                                       |
| get          | `get_task`                                                                             |
| apply        | `apply_to_task`, then `get_submission`                                                 |
| upload       | `add_text_sample` for text; `request_upload` → signed PUT → `confirm_upload` for files |
| remove       | `remove_sample`                                                                        |
| submit       | `submit_samples`, then `get_submission`                                                |
| status, list | `get_submission`, `my_submissions`                                                     |
| link         | `get_upload_link`: a 15-minute web link that signs the person in                       |
| account      | `whoami`, `update_profile`                                                             |

**How a task works.** A task names its questions, the files or text it needs (`requirements`), how to record (`how_to`, `looks_like`, `rules`) and sometimes the material itself (`instructions`). The first samples verify the person; paid work at the task's rate follows verification. `apply` makes an application with stage `work_needed` (or `applied` when the team unlocks the task first), `upload` adds samples until `progress.ready_to_submit`, `submit` sends them for review, and `status` reports `in_review`, then `accepted` or `rejected` with the reviewer's note.

**Key.** Reads work without one. Applying, uploading and submitting need `KARIAA_API_KEY`, created at https://www.kariaa.com/datahouse/connect. In Claude, ChatGPT or Perplexity a person can instead sign in with Kariaa through `https://agent.kariaa.com/mcp/auth`; that path is Kariaa's own server, not this one.

**Profile.** Applying needs a name, phone, location and occupation on the account. `whoami` reports what is `missing`; `update_profile` takes `legal_first_name`, `legal_last_name`, `phone_number`, `location`, `occupation` (a list), `language`, `email`.

**Limits.** 60 writes and 2000 calls per key per day, 10 files per task, 100 MB per file, upload links valid for two hours, written answers of 20 to 20 000 characters. `rate_limited` carries `retry_after`.

`KARIAA_MCP_URL` points the connector at another endpoint, for a local Kariaa server.

### Earnings and payouts

`earnings` and `payout` call two tools on the same `/mcp` endpoint, signed-in only (live since 2026-10-27). A payout pays the whole balance, at least 10 USD, one open request at a time; Kariaa sends the money by PayPal, Venmo, gift card or USDC on Base, to the destination saved on the profile. The contract:

**`my_earnings`** (no input) →

```json
{
  "balance": { "amount": 12.5, "currency": "USD" },
  "total_earned": { "amount": 13, "currency": "USD" },
  "pending": { "amount": 0, "currency": "USD" },
  "entries": [
    { "id": "…", "submission_id": "<uuid>", "task_title": "…", "amount": 12.5, "currency": "USD", "status": "available", "earned_at": "…" }
  ],
  "payouts": [
    {
      "payout_id": "<uuid>",
      "amount": 0.5,
      "currency": "USD",
      "method": "paypal",
      "destination": "…",
      "status": "paid",
      "requested_at": "…",
      "paid_at": "…"
    }
  ],
  "min_payout": { "amount": 10, "currency": "USD" },
  "methods": ["paypal", "venmo", "giftcard", "crypto"]
}
```

`entries` come from the earnings ledger (`task_earning` rows), `balance` and `total_earned` from the account's balance fields, `payouts` from the payout requests. Entry `status` is `pending`, `available` or `paid`; payout `status` is `requested`, `paid` or `rejected`.

**`request_payout`** `{ amount?, method, destination?, note? }` → `{ payout_id, amount, currency, method, destination, status: "requested", requested_at }`. No `amount` means the whole balance.

Error codes the connector maps: `method_not_supported{methods}`, `destination_required`, `destination_invalid` → `invalid_input`; `below_minimum{min_payout}`, `insufficient_balance{balance}`, `nothing_to_pay` → `not_ready`; `payout_pending{payout_id}` → `already_exists`; `sign_in_required` → `auth_required`. One open request at a time.

## `kariaa-jobs`: job listings

Listings Kariaa aggregates from Indeed, LinkedIn, Himalayas, Jobberman and other boards, anywhere in the world, with pay where the posting states it. Find only: `search` needs at least two characters of query; `get` returns the full posting with its description and where to apply. A key is optional and raises the search limit from 10 to 30 an hour.
