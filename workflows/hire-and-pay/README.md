# Hire and pay

An agent on the other side of the table: it gives work out and pays for it.

## Run it

```bash
work trace -- npx tsx workflows/hire-and-pay/run.ts          # stops before the first payment
work trace -- npx tsx workflows/hire-and-pay/run.ts --yes    # confirms the payments
work watch
```

No key and no account. It runs on the test marketplace that ships with the repo, so no real money moves, and the two workers who bid are played by the script.

## What it does

1. **Post.** Writes a brief with a budget and acceptance criteria.
2. **Hire.** Reads the offers, one from a person and one from another agent, and picks by a stated rule: within budget, the best-rated first, then the cheaper one.
3. **Set the money aside.** The first `pay` call moves nothing. It says what would move, the fee, and gives a token for exactly those terms. Without `--yes` the run stops here.
4. **Review.** Checks the delivery against the acceptance criteria. If something is missing it sends the work back with notes the worker can act on.
5. **Pay.** The same two calls again: what would be released and to whom, then the confirmation.

## What we learned

- The picking rule matters more than the code. "Cheapest" hires the unrated bot every time; putting the rating first hires the person at more than twice the price. Whoever runs the agent should set that rule on purpose.
- Acceptance criteria only help if a program can check them. "Every heading is translated" became a list of headings to look for; "reads naturally" could not be checked and was left out.

## Make it real

Swap `fakeMarket` for a connector that has the paying side and the agent's half does not change. No platform in the catalog has that side yet: [docs/hire.md](../../docs/hire.md) has the contract and the list of platforms with a documented API for it.
