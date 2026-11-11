# Giving work out

Most of this repo is about an agent doing work and getting paid. This page is the other side: an agent (or a person through an agent) posts a job, reads the offers, picks one, reviews what comes back and pays for it.

With both sides, money can move in every direction:

| who pays whom          | how it looks here                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| a person pays an agent | the person posts on a marketplace; the agent finds it, applies, delivers ([earn.md](earn.md)) |
| an agent pays a person | the agent posts a job on a freelance or task marketplace and pays the person who does it      |
| an agent pays an agent | the agent posts on a marketplace where agents bid; another agent delivers                     |

## What works today

The whole loop runs through the library, the MCP tools and the command line, with the confirm step on every payment. `tests/buying.test.ts` drives it against `tests/helpers/fakeMarket.ts`, a complete in-memory marketplace. A connector that brings this side to a real platform is the most valuable pull request here: see [Adding the buying side to a connector](#adding-the-buying-side-to-a-connector).

## The loop

| step            | library           | MCP tool         | command line                                                                      |
| --------------- | ----------------- | ---------------- | --------------------------------------------------------------------------------- |
| post            | `post()`          | `post_job`       | `work post --connector <id> --title … --description … --budget 30 --currency USD` |
| your postings   | `postings()`      | `my_postings`    | `work posted`                                                                     |
| read the offers | `offers()`        | `list_offers`    | `work offers <posting>`                                                           |
| pick one        | `award()`         | `award_offer`    | `work award <posting> <offer>`                                                    |
| review the work | `review()`        | `review_work`    | `work review <posting> accept\|changes\|reject`                                   |
| pay             | `pay()`           | `pay_for_work`   | `work pay <posting> fund\|release`                                                |
| close           | `cancelPosting()` | `cancel_posting` | `work cancel <posting>`                                                           |

```ts
import { createProtocol } from "kariaa-agents";

const work = await createProtocol();
try {
  const posting = await work.post("some-market", {
    title: "Translate a product page into Spanish",
    description:
      "Translate the 600-word page at https://example.com/page into neutral Latin American Spanish. Keep the headings and the HTML tags.",
    budget: { amount: 30, currency: "USD" },
    acceptance: ["Every heading and paragraph is translated", "Reads as written by a native speaker"],
    workers: "human",
  });

  const { offers } = await work.offers(posting.id); // later: who offered, their price, their note
  const pick = offers[0];
  if (pick) {
    await work.award(posting.id, pick.id);

    const ask = await work.pay(posting.id, { action: "fund" });
    console.log(ask.next); // what would move, to whom, with what fee; nothing has moved yet
    // …show it to the person, and only if they agree:
    await work.pay(posting.id, { action: "fund", confirm: ask.confirm });
  }
} finally {
  await work.close();
}
```

## Money takes two calls

`pay` never moves money the first time it is called. It answers `confirm_needed` with the amount, the fee, who receives it, and a `confirm` token. The token is signed on your machine for exactly that posting, offer, action, amount, fee and receiver, and it is good for fifteen minutes. Money moves only when the same call is made again with the token. Change any of the terms and the token no longer fits; nobody can work one out ahead of the first call.

A payment is never confirmed blind: where a platform does not say what is owed, `pay` asks for the amount instead of guessing.

This is in the router, not in each connector, so every platform gets it and no connector can skip it. It gives an agent a natural place to stop and show the person what it is about to do.

`fund` sets money aside (escrow, a funded milestone). `release` hands it to the worker. Left out, the platform's next needed step is used.

## Writing a good posting

The offers you get are as good as the brief.

- Say what goes in and what comes out: the input, the deliverable, its format.
- Write `acceptance` lines someone could check. "Reads well" is not one; "every heading and paragraph is translated" is.
- Set `workers` when it matters whether a person or an agent does it.
- Budget what the work is worth to the person paying. An agent does not set its owner's budget.

## Rules

- The person the agent acts for decides the budget, which offer wins and every payment. Ask each time.
- Review the work against the posting's own acceptance lines, and say exactly what to change when it falls short.
- Pay for accepted work promptly. People and agents on the other side are relying on it.
- No posting work to get free samples, and no posting a job the poster does not mean to award.

## Adding the buying side to a connector

A connector implements the steps its platform supports; `stages` then lists them and the tools start working for it.

```ts
import { defineConnector, ProtocolError } from "kariaa-agents";

export const someMarket = defineConnector({
  id: "some-market",
  name: "Some Market",
  description: "…",
  kinds: ["task"],
  auth: { type: "api_key", env: ["SOME_MARKET_TOKEN"], help: "Where the key comes from." },

  async post(input, ctx) {
    // Create the job. Do not charge here: return it unfunded.
    return { id: "123", title: input.title, status: "open", budget: input.budget, funded: false };
  },
  async postings(ctx) {
    return [];
  },
  async offers(postingId, ctx) {
    // The posting and every bid on it, or null when it is not yours.
    return null;
  },
  async award(postingId, offerId, ctx) {
    throw new ProtocolError("not_supported", "…");
  },
  async quote(postingId, input, ctx) {
    // What pay would do: the amount, the fee, who receives it. Moves nothing.
    return { status: "confirm_needed", action: "fund", amount: { amount: 30, currency: "USD" } };
  },
  async pay(postingId, input, ctx) {
    // Called only after the confirm step. This is where money moves.
    return { status: "funded", action: "fund", amount: input.amount };
  },
});
```

Test it on recorded responses with `describeBuyerConformance` from `kariaa-agents/testing`, and never against the live platform from a test: these calls post real jobs and move real money. Where the platform has a sandbox, say in the connector's README how to point at it.

`tests/helpers/fakeMarket.ts` is a complete in-memory marketplace and `tests/buying.test.ts` drives the whole loop through the library, the MCP tools and the command line; both are good starting points.

Platforms with a documented buyer API that nobody has connected yet: Freelancer.com (projects, bids, milestones, with a sandbox), OpenTask (proposals, contracts, payments), Whop (bounties, with a sandbox), NEAR Agent Market (through its MCP server), Amazon Mechanical Turk and Prolific (tasks for people).
