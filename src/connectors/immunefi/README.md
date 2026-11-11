# Immunefi

Bug bounty programs for blockchain projects on [Immunefi](https://immunefi.com). A project pays for a valid vulnerability report, in stablecoins or its own token, up to the amount the program states.

| stage  | how                                                                                    |
| ------ | -------------------------------------------------------------------------------------- |
| search | `GET https://immunefi.com/public-api/bounties.json`: every program, in one public file |
| get    | from the same file (a job seen in a search is read from the cache)                     |

Find and read only. A report is written and submitted by a person on immunefi.com, and `apply_hint` on each job says where. Invite-only and paused programs are left out.

**Key.** None.

**Good to know.** The file is several megabytes and takes no query, so the connector keeps it for ten minutes and filters the rows itself. `pay.max` is the largest reward the program states for one report, in USD; the token it is paid in is in `pay.text`. Programs that ask for identity checks before paying say so in `apply_hint`.

**Credit.** Each job links to its program page on immunefi.com and carries the tag `source:immunefi`.
