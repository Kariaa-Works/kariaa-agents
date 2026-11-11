# Ledger

One page that says where your work and your money stand, across every platform you have linked.

## Run it

```bash
work trace -- npx tsx workflows/ledger/run.ts
work watch
```

The page is written to `.work/ledger.md`. It needs at least one key in `.env`: a Kariaa key, or your own key for any platform here (`work connect` lists them).

## What it does

1. **Accounts.** Asks which platforms you are signed in to.
2. **Applications.** Reads everything you have applied to or handed in, on all of them.
3. **Earnings.** Reads each platform's balance, what is pending and what was earned so far.
4. **Sorts it** into four parts: what needs you today, what is waiting on someone else, what was accepted, and the money.

It only reads. Nothing is applied to, sent or paid out, so it is safe to run on a schedule.

## What we learned

- "Needs you" is the part people open the page for. A task that was unlocked and is waiting for samples is easy to forget when it sits in a list with everything else.
- A platform that does not report earnings through its API is left out of the money part and is not counted as a failure.

## Ideas to build on

- Say when a balance has crossed the platform's minimum and offer the payout, with the person confirming it.
- Keep yesterday's page and report only what changed.
