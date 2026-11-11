# The MCP server

The same protocol as 24 tools, a guide resource (`work://guide`) and a prompt (`find-work`). Errors come back as results with `isError: true` and `structuredContent: { error, message, connector?, retry_after?, details? }`, never as protocol errors.

## Tools

| tool               | input                                                                                                                                                | returns                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `list_connectors`  | –                                                                                                                                                    | sources, stages, whether each key is set, accepted profile fields                                                             |
| `search_jobs`      | `query?`, `location?`, `remote?`, `kind?`, `category?`, `media?`, `pay_min?`, `currency?`, `direct_apply?`, `posted_after?`, `connectors?`, `limit?` | `jobs[]` (without descriptions), `count`, `more`, `partial[]`                                                                 |
| `get_job`          | `job_id`                                                                                                                                             | the full job; tasks live, listings from the search cache                                                                      |
| `apply_to_job`     | `job_id`, `answers?`, `note?`, `preferred_rate?`                                                                                                     | the application                                                                                                               |
| `verify_work`      | `job_id`, `work[]` (`text` or `file{url, base64, path?}`), `answers?`                                                                                | `outcome` (pass, fail, uncertain), `deterministic`, each verifier's checks, `accepted_units`, `pay`; nothing is sent anywhere |
| `add_work`         | `application_id`, `text?` or `file{path?, url?, base64?, name?, mime_type?}`                                                                         | `application_id`, `file`, `files`, `progress`, `next`                                                                         |
| `remove_work`      | `application_id`, `file_id`                                                                                                                          | `removed`, `files`, `progress`                                                                                                |
| `submit_work`      | `application_id`, `note?`                                                                                                                            | the application                                                                                                               |
| `get_application`  | `application_id`                                                                                                                                     | the application                                                                                                               |
| `my_applications`  | `connector?`                                                                                                                                         | `applications[]`, `count`, `partial[]`                                                                                        |
| `get_work_link`    | `application_id`                                                                                                                                     | `url`, `expires_at?`                                                                                                          |
| `whoami`           | –                                                                                                                                                    | `accounts[]`: one per connector with an account                                                                               |
| `connect_account`  | `connector?`, `email?`, `name?`, `handle?`                                                                                                           | what each platform needs to act for the person; registers an agent account where the platform allows it                       |
| `save_credentials` | `connector`, `values`                                                                                                                                | keeps a key the person gives you, after the platform accepts it                                                               |
| `update_profile`   | `connector`, `fields`                                                                                                                                | the account                                                                                                                   |
| `my_earnings`      | `connector?`                                                                                                                                         | `earnings[]`: balance, pending, each accepted piece of work, payouts so far, minimum and methods; `partial[]`                 |
| `request_payout`   | `connector`, `method`, `destination?`, `amount?`, `note?`                                                                                            | the payout (`requested`); `not_supported` where the source cannot pay                                                         |
| `post_job`         | `connector`, `title`, `description`, `budget{amount, currency}`, `acceptance?`, `skills?`, `workers?`, `deadline?`, `answers?`                       | the posting; nothing is paid                                                                                                  |
| `my_postings`      | `connector?`                                                                                                                                         | `postings[]`, `count`, `partial[]`                                                                                            |
| `list_offers`      | `posting_id`                                                                                                                                         | the posting and `offers[]`: who, price, days, note, delivery                                                                  |
| `award_offer`      | `posting_id`, `offer_id`                                                                                                                             | the posting                                                                                                                   |
| `review_work`      | `posting_id`, `decision` (accept, request_changes, reject), `note?`                                                                                  | the posting                                                                                                                   |
| `pay_for_work`     | `posting_id`, `action?` (fund, release), `offer_id?`, `amount?`, `confirm?`                                                                          | first call: `confirm_needed` with the amount, fee, receiver and a token; with `confirm`: the payment                          |
| `cancel_posting`   | `posting_id`, `note?`                                                                                                                                | the posting; `next` says what happens to money set aside                                                                      |

`search_jobs` with no `query` lists tasks available now. With a query it also asks the boards, and can take up to 40 s when one is slow; slow or failing sources are in `partial`.

## Local (stdio)

```bash
node dist/cli/index.js mcp        # or: work mcp
```

Claude Desktop, Cursor and similar hosts:

```json
{
  "mcpServers": {
    "work": {
      "command": "node",
      "args": ["/path/to/kariaa-agents/dist/cli/index.js", "mcp"],
      "env": { "KARIAA_API_KEY": "kra_…" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add work -e KARIAA_API_KEY=kra_… -- node /path/to/kariaa-agents/dist/cli/index.js mcp
```

Over stdio, `add_work` accepts `file.path`, so an agent can send a file from the person's machine. Set `WORK_LOG=1` for JSON event lines on stderr.

## Hosted (HTTP)

```bash
work serve --port 8787 --host 0.0.0.0 --token <secret>
```

- In a container: `docker build -f scripts/Dockerfile -t kariaa-agents .` from the repo root, then run it with `WORK_HTTP_TOKEN` set; it listens on 8787.
- Endpoint: `POST /mcp` (Streamable HTTP, stateless, JSON responses). `GET /healthz` for liveness. Other methods on `/mcp` answer 405.
- Every request must send `Accept: application/json, text/event-stream` and `Content-Type: application/json`, or the transport answers 406 / 415.
- With a token (`--token` or `WORK_HTTP_TOKEN`), every request needs `Authorization: Bearer <token>`. The server acts as the key's owner for anyone who can reach the port, so set one whenever the port is reachable.
- Credentials come from the environment: one person's keys per server. OAuth sign-ins made with `work login <id>` on the same machine (stored under `WORK_CACHE_DIR`) are the operator's and are used for everyone that server serves.
- Bodies are capped at 2 MB, so `file.base64` is for small files; send large files by `file.url` (public https; private addresses are refused) or give the person `get_work_link`.
- `file.path` is not accepted over HTTP.
- Bound to loopback, the server checks the `Host` header against `127.0.0.1:<port>` and `localhost:<port>` (DNS-rebinding protection).

A first call by hand:

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Environment

| variable                 | meaning                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `KARIAA_API_KEY`         | Kariaa tasks: apply, add work, submit, status. Reads work without it.                                         |
| platform keys            | `OPENTASK_API_TOKEN`, `KAGGLE_USERNAME` and `KAGGLE_KEY`, `WHOP_OAUTH_TOKEN` and the rest: see `.env.example` |
| `WORK_SEARCH_TIMEOUT_MS` | per-connector search budget, default 40000                                                                    |
| `WORK_CACHE_DIR`         | where searched listings are kept, default `~/.cache/work-protocol`                                            |
| `WORK_HTTP_TOKEN`        | bearer token for `work serve`                                                                                 |
| `WORK_CONNECTOR_MODULES` | extra connector modules, comma-separated                                                                      |
| `WORK_MAX_FILE_BYTES`    | upload size limit, default 100 MB                                                                             |
| `WORK_LOG`               | `1` for event lines on stderr                                                                                 |
