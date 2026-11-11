# Scout

Finds work that fits one person and says why, so they start from three good options instead of fifty listings.

## Run it

```bash
work trace -- npx tsx workflows/scout/run.ts
work watch
```

The shortlist is written to `.work/shortlist.md`. Change who it scouts for in [profile.json](profile.json): skills, what to search for, and a short introduction.

With `KARIAA_API_KEY` set, the shortlist also shows where earlier applications stand, and `--apply` applies to the best Kariaa task, once:

```bash
work trace -- npx tsx workflows/scout/run.ts --apply
```

## What it does

1. **Find.** One search per phrase in the profile, merged across every platform in the catalog.
2. **Rank.** Skills that match, pay that is stated, and whether the job can be acted on through the API (apply, add work, submit) rather than only read.
3. **Read.** The top three in full, for their questions, rules and how to apply.
4. **Verify.** Takes the answers the person gave in `profile.json` and checks them against the job's questions. A question the profile does not answer is listed as "needs from you"; nothing is made up, and nothing is sent.
5. **Apply**, only with `--apply`, only when the answers passed: one Kariaa task per run.
6. **Track**, with a key: the person's applications and their stage.

## What we learned

- Most results can only be read through the API and are finished on the platform's site. Ranking jobs an agent can act on first changes the shortlist more than any keyword tuning.
- `verify` catches an unanswered or mismatched answer before a reviewer does.
- A platform that fails or times out does not fail the search: it is listed in `partial` and the rest come back.
