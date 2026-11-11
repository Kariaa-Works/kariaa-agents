# YesWeHack

Public bug bounty and vulnerability disclosure programs on YesWeHack (about 56 live programs), through the program endpoints documented at `https://api.yeswehack.com/doc`. A program is a task: find a vulnerability in its scopes and submit a report on yeswehack.com; the bounty follows the program's reward grid (severity by asset value), in EUR or USD.

| stage  | how                                                                                                                                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| search | `GET /programs?page=N&resultsPerPage=100`: every public program (cached ten minutes), with words, place and remote filtered here. The API's own `filter[search]` matches titles only, so the words are matched over the title, company and summary. |
| get    | `GET /programs/{slug}`: rules, scopes with their asset value (`raw.scopes`), out-of-scope items, qualifying and non-qualifying vulnerabilities, account access notes and the reward grid (`raw.reward_grid`).                                       |

Reports are submitted on the program page (`https://yeswehack.com/programs/{slug}`) with a YesWeHack hunter account. The API's personal access tokens are issued to business unit owners, business unit managers and program managers only, so there is no apply, submit or earnings stage. Archived or disabled programs are find-only; programs open to verified hunters only say so in `requirements.rules`. No key.

The list and a program detail were read live; the fixtures are trimmed captures.
