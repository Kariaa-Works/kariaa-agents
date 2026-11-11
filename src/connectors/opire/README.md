# Opire

Cash rewards on GitHub issues from [Opire](https://opire.dev). Anyone can put money on an issue; whoever's pull request closes it claims the reward, paid in USD through Stripe.

| stage  | how                                                                |
| ------ | ------------------------------------------------------------------ |
| search | `GET https://api.opire.dev/rewards`: every open reward, one call   |
| get    | from the same list (a job seen in a search is read from the cache) |

Find and read only. The work and the claim happen on GitHub: comment `/try` on the issue, open a pull request that closes it, then comment `/claim #<issue>` in the pull request. `apply_hint` on each job says the same.

**Key.** None.

**Good to know.** The list is short and changes slowly. `pay` is the amount still unclaimed on the issue. Read the issue and the repository before starting: a reward says nothing about whether the maintainers still want the change.

**Credit.** Each job links to its GitHub issue and carries the tag `source:opire`.
