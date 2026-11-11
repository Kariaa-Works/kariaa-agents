# Writing a connector

A connector is one source. It returns jobs and applications in the protocol's shapes, using the source's own ids, and implements the stages the source supports.

## The contract

```ts
import { defineConnector } from "kariaa-agents";

export const connector = defineConnector({
  id: "my-source",                    // lowercase letters, digits, dashes
  name: "My Source",
  description: "What it covers, where, and which stages.",
  homepage: "https://example.com",
  kinds: ["listing"],                 // and/or "task"
  auth: { type: "none" },             // or { type: "api_key", env: ["MY_SOURCE_KEY"], help: "Keys at …", required?: boolean }
  profileFields: [...],               // only with updateAccount
  optIn: true,                        // searched only when named: local process, chain reads, paid calls

  async search(query, ctx) { return { jobs: [...], more: false }; },
  async get(nativeId, ctx) { ... },
  async apply(nativeId, input, ctx) { ... },
  async upload(nativeAppId, work, ctx) { ... },   // work: { kind: "text", text } | { kind: "file", name, mime_type, bytes }
  async remove(nativeAppId, fileId, ctx) { ... },
  async submit(nativeAppId, input, ctx) { ... },
  async status(nativeAppId, ctx) { ... },
  async list(ctx) { ... },
  async link(nativeAppId, ctx) { ... },
  async account(ctx) { ... },
  async updateAccount(fields, ctx) { ... },
  async close() { ... },
});
```

The full interface is in `src/core/connector.ts`; the shapes in `src/core/types.ts`.

`ctx` gives you:

- `credentials`: the values of `auth.env`, from the environment or the caller.
- `fetch`: use it for every request. Hosts and tests replace it; the conformance suite fails a connector that reaches for the global one.
- `signal`: aborted when the caller's budget is spent. Pass it to every request.
- `log(event, data)`: structured, to stderr or nowhere. Never log credentials.

### What to return

- Jobs and applications in their **native** shapes: `id` and `job_id` as the source knows them, no `connector` field. The router prefixes ids and sets `connector`.
- `stages` on a job only to narrow the connector's stages for that job; otherwise leave it out.
- `upload` and `remove` return a `WorkReceipt`: the file touched, the files now in, `progress`, and `next`.
- `apply` and `submit` return the application as it stands afterwards, even when the source needs a second call for that.
- Throw `ProtocolError` with the code that fits (`docs/protocol.md`). Anything else thrown becomes `upstream_error`.

### Behaviour

- `apply` twice returns the existing application. `submit` twice returns the current one.
- A duplicate upload answers `already_exists` with the existing file in `details`.
- Reads work without a credential wherever the source allows it; writes answer `auth_required` with the message from `auth.help`.
- Respect `ctx.signal`; a slow source must not hold the whole search.

## Boards with a JSON search API

`defineJsonBoard` handles the request, the error mapping, row validation and the filters the API does not apply itself. A board is a few declarative lines:

```ts
import { defineJsonBoard, iso, str, strings, stripHtml } from "kariaa-agents";

export const myBoard = defineJsonBoard({
  id: "my-board",
  name: "My Board",
  description: "Remote jobs from My Board. Find only.",
  homepage: "https://myboard.example",
  request: (query) => {
    const url = new URL("https://myboard.example/api/jobs");
    if (query.query?.trim()) url.searchParams.set("q", query.query.trim());
    return url; // or null when there is nothing to ask
  },
  rows: (body) => (body as { jobs?: unknown[] }).jobs ?? [],
  map: (row) => {
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    const title = str(r.title);
    if (!id || !title) return null;
    return {
      id,
      kind: "listing",
      title,
      org: str(r.company),
      location: { text: str(r.location), remote: r.remote === true },
      summary: stripHtml(str(r.description), 300),
      description: stripHtml(str(r.description), 6000),
      url: str(r.url),
      posted_at: iso(r.posted),
      tags: [...strings(r.tags), "source:my-board"],
    };
  },
  applies: { query: true }, // filters the API applied; the rest run here
  more: (body) => Boolean((body as { next?: unknown }).next),
  cacheTtlMs: 10 * 60_000, // for feeds that ignore the query
  auth: { type: "api_key", env: ["MY_BOARD_KEY"], help: "Keys at …" }, // when needed
});
```

Helpers: `str`, `num`, `iso` (a timestamp without a zone is read as UTC), `strings`, `stripHtml(html, max)`, `truncate`, `queryWords`, `locationFits`, `applyFilters`.

More options:

- `request` can return `{ url, method, body, headers }` instead of a URL: a POST search with a JSON body, or headers built from the credentials (`headers: { "x-api-key": credentials.MY_BOARD_KEY }`).
- `kinds: ["task"]` for bounty, gig and campaign feeds (the default is `["listing"]`).
- `optIn: true` for a source that is searched only when named: one that needs a configured company list, starts a process, reads a chain or costs money per call.
- A keyed board that answers 401 or 403 becomes `auth_required` with its `auth.help`.

## Boards with an RSS or XML feed

`defineFeedBoard` is the same helper for RSS 2.0, Atom and plain XML. `map` receives one `FeedItem`: `title`, `link`, `id`, `description`, `content`, `published`, `updated`, `categories`, `author`, every other child element as text in `fields`, and their attributes in `attributes`. Set `itemTag` when one posting sits in an element other than `item` or `entry`.

```ts
import { defineFeedBoard, iso, stripHtml, type FeedItem } from "kariaa-agents";

export const myFeed = defineFeedBoard({
  id: "my-feed",
  name: "My Feed",
  description: "Jobs from My Feed's RSS. Find only.",
  homepage: "https://myfeed.example",
  request: () => "https://myfeed.example/jobs.rss",
  map: (row) => {
    const item = row as FeedItem;
    if (!item.title || !item.link) return null;
    return {
      id: item.id ?? item.link,
      kind: "listing",
      title: item.title,
      summary: stripHtml(item.description, 300),
      url: item.link,
      posted_at: iso(item.published),
      tags: [...item.categories, "source:my-feed"],
    };
  },
  cacheTtlMs: 10 * 60_000, // a feed ignores the query; the words are matched here
});
```

`parseFeed(xml, itemTag?)` and `xmlText` are exported for connectors that read a feed inside a richer flow.

## Linking an MCP server

A platform that exposes an MCP server needs no code here: a profile maps its tools onto the stages, and `defineMcpConnector` turns it into a connector.

```ts
// src/connectors/acme/profile.ts
import type { McpProfileInput } from "../../core/mcp/profile.js";

export const profile = {
  id: "acme",
  name: "Acme gigs",
  description: "Short paid gigs from Acme.",
  kinds: ["task"],
  transport: { type: "http", url: "https://acme.example/mcp" },
  auth: { type: "bearer", env: "ACME_API_KEY", help: "Keys at https://acme.example/keys. Browsing works without one.", required: false },
  tools: {
    search: {
      name: "list_gigs",
      args: { q: "$.query", limit: "$.limit" },
      items: "$.gigs",
      map: { id: "$.id", title: "$.title", "pay.text": "$.reward" },
    },
    get: { name: "get_gig", args: { gig_id: "$.id" }, map: { id: "$.id", title: "$.title", description: "$.body" } },
    apply: { name: "claim_gig", args: { gig_id: "$.id" }, map: { stage: { const: "work_needed" } } },
    submit: { name: "deliver", args: { gig_id: "$.id", text: { from: "$.note", required: true } }, map: { stage: { const: "in_review" } } },
  },
  sample: { query: "" },
} satisfies McpProfileInput;

// src/connectors/acme/index.ts
import { defineMcpConnector } from "../../core/mcp/profile.js";
import { profile } from "./profile.js";
export const acme = defineMcpConnector(profile);
```

`work draft https://acme.example/mcp --query gigs --out src/connectors` writes the first version from the server's tool list and a sample result. [mcp-profiles.md](mcp-profiles.md) has the whole language (paths, templates, transforms, value maps, synthetic apply, OAuth, stdio servers) and the fake-server test pattern. A server that answers in prose rather than JSON gets a code connector that parses it.

## Rules

- Public or documented APIs only. No scraping where a site's terms forbid it, no logins the person did not give you.
- Keyless where the source allows it. Otherwise name the environment variables in `auth.env` and say where to get them in `auth.help`.
- Credit the source the way it asks: link back through `url`, add a `source:<id>` tag.
- Nothing that costs money per call.
- Keep the connector's own types out of the protocol shapes. Put extras in `raw` when a consumer would need them.

## Tests

Every connector folder has `index.test.ts`. For a board, run the conformance suite against a trimmed real response:

```ts
import { readFileSync } from "node:fs";
import { describeConnectorConformance, fixtureFetch } from "../../core/conformance.js";
import { myBoard } from "./index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8"));
describeConnectorConformance(myBoard, { search: { query: "developer" }, fetch: fixtureFetch(fixture) });
```

The suite checks the id, that `search` returns valid native jobs through `ctx.fetch` with `ctx.signal`, that the request carried the query (`expectQueryInUrl: false` for feeds that cannot search), and that a failing source becomes a `ProtocolError`. `npm run test:live` runs the same checks against the network.

Capture a fixture with one request, trim it to three rows and short descriptions, and keep it under a few KB.

A connector written by hand passes the same suite as long as every request goes through `ctx.fetch`: the suite swaps it for the fixture, and for a failing source. A `search` that returns a fixed list without fetching fails it. `fetchJson` does both halves for you:

```ts
import { defineConnector } from "../../core/connector.js";
import { fetchJson } from "../../core/http.js";

type Row = { id: string; title: string; url: string };

export const mySource = defineConnector({
  id: "my-source",
  name: "My Source",
  description: "Open tasks from My Source. Find only.",
  homepage: "https://example.com",
  kinds: ["listing"],
  auth: { type: "none" },

  async search(query, ctx) {
    const url = new URL("https://example.com/api/jobs");
    if (query.query) url.searchParams.set("q", query.query);
    // Goes through ctx.fetch with ctx.signal, and turns a failing source into a ProtocolError.
    const data = await fetchJson<{ jobs: Row[] }>(ctx, url, { label: "My Source", connector: "my-source" });
    return { jobs: data.jobs.map((row) => ({ id: row.id, kind: "listing" as const, title: row.title, url: row.url })), more: false };
  },
});
```

Its test is the one above with `fixtureFetch({ jobs: [{ id: "1", title: "Example developer", url: "https://example.com/jobs/1" }] })`.

## Out-of-tree connectors

A module that exports `connector`, `connectors` or a default is loaded from `WORK_CONNECTOR_MODULES` (comma-separated package names or paths) by the CLI and the MCP server, or passed as `modules` to `createProtocol`.

## Pull request checklist

- [ ] `src/connectors/<id>/index.ts`, `README.md`, `index.test.ts`, `fixtures/search.json` (a linked MCP server: `profile.ts`, a one-line `index.ts`, a test on `createFakeMcp` with trimmed read fixtures under `fixtures/`)
- [ ] import added to `src/connectors/index.ts`; row added to the table in `docs/catalog.md`
- [ ] credentials, if any, listed in `.env.example` (a test checks this)
- [ ] `npm test` and `npm run typecheck` pass; `npm run test:live -- src/connectors/<id>` passes once; `work search <word> --connector <id>` returns rows

## The buying side

A marketplace has two sides. Besides finding and doing work, a connector can implement `post`, `postings`, `offers`, `award`, `review`, `pay` (with `quote`) and `cancel`, so an agent can give work out and pay for it there. [hire.md](hire.md) has the contract, the confirm step every payment goes through, and how to test it with `describeBuyerConformance`.
