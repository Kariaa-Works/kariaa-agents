# Linking an MCP server with a profile

A profile is a TypeScript object that tells the protocol which of a server's tools answer each stage, what to send them, and how to read what comes back. `defineMcpConnector(profile)` turns it into a connector; nothing else is written. `src/connectors/dice` is one: read it before writing your own.

## Shape

```ts
import type { McpProfileInput } from "../../core/mcp/profile.js";

export const profile = {
  id: "acme", // the connector id: lowercase letters, digits, dashes
  name: "Acme gigs",
  description: "What the platform offers, in one or two sentences.",
  homepage: "https://acme.example",
  kinds: ["task"], // "task", "listing", or both
  transport: { type: "http", url: "https://acme.example/mcp" },
  auth: { type: "none" },
  tools: { search: {/* … */} }, // search is required; the other stages are optional
  sample: { query: "" }, // what the live tests and the smoke sweep search for
  optIn: true, // searched only when named: local processes, chain reads, paid calls
  notes: "Anything the next person should know.",
} satisfies McpProfileInput;
```

### transport

- `{ type: "http", url }`: Streamable HTTP. One connection per credential is kept open and shared.
- `{ type: "stdio", command, args?, env?, envFrom? }`: a local server process (`npx -y some-mcp@1.2.3`). `envFrom` names host variables copied into the process when set.

### auth

| type     | fields                                 | effect                                                                                                                       |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `none`   |                                        | nothing is sent                                                                                                              |
| `bearer` | `env`, `help`, `required?`             | `Authorization: Bearer <value of env>`                                                                                       |
| `header` | `name`, `env`, `help`, `required?`     | `<name>: <value of env>`                                                                                                     |
| `oauth`  | `help?`, `scope?`, `env?`, `required?` | tokens from `work login <id>` (or a static token in `env`); without them the write stages answer `auth_required` with `help` |
| `env`    | `env`, `help`, `required?`             | for stdio servers: the credential is put in the process environment                                                          |

`required: false` means the read stages work without a credential; writes still need one. The credential is also reachable from argument maps as `$.credentials.<ENV>` for servers that take the key as a tool argument.

### tools

Each stage names a tool call:

```ts
{
  name: "browse_jobs",
  args: { status: "open", search: "$.query", limit: { from: "$.limit", transform: "int", default: 20 } },
  items: "$.jobs",                  // search and list: the array in the result
  more: "$.pagination.has_more",    // search: whether there is more
  root: "$.job",                    // get, status, account: the object in the result
  map: { /* result → protocol fields, below */ },
  filter: ["query", "location"],    // search: filters the server ignored, applied here
  skipWithout: ["$.location"],      // search: inputs the tool cannot do without; otherwise answer nothing
  then: "status",                   // submit: re-read the application after the call
}
```

Stages: `search` (required), `get`, `apply`, `submit`, `status`, `list`, `earnings`, `account`, `link`. The connector supports exactly the stages the profile names. `apply` may be `{ synthetic: true, next: "…" }` when taking the work is the submission: nothing is called and the application starts at `work_needed`.

### Arguments

A value in `args` is a literal (`"open"`, `1`, `true`), an input path (`"$.query"`), or `{ from, default?, required?, transform? }`. Inputs by stage:

| stage             | inputs                                                       |
| ----------------- | ------------------------------------------------------------ |
| search            | `$.query`, `$.location`, `$.remote`, `$.kind`, `$.limit`     |
| get, status, link | `$.id`                                                       |
| apply             | `$.id`, `$.answers.<question>`, `$.note`, `$.preferred_rate` |
| submit            | `$.id`, `$.note`                                             |
| every stage       | `$.credentials.<ENV>`                                        |

`required: true` on a missing input answers `invalid_input` naming the field, so an agent learns what to give as `answers.<field>`. Transforms: `int`, `number`, `bool`, `lower`, `csv` (a list into one comma-separated string), `list` (a comma-separated string, or one value, into a list, for tools that take arrays), `string`, `preview` (the first 500 characters), `last` (the part after the last comma, for the country at the end of a place).

### Fields

A value in `map` is a result path (`"$.title"`) or `{ … }` with:

- `path` or `paths` (the first path with a value wins), `input` (fall back to the input scope, `{ input: "$.id" }`), `template` (`"https://acme.example/jobs/${slug}"`, `"${city}, ${country}"`), `const`, `default`
- `values` to rename (`{ path: "$.status", values: { open: "applied", done: "accepted", "*": "closed" } }`; booleans and numbers are matched as strings)
- `transform`: `cents` (divide by 100), `number`, `int`, `string`, `lower`; `join` for arrays
- `items` and `fields` for a nested list

Paths: `$.a.b`, `$.a[0]`, `$.a[*].b`, and `$` for the whole item. Keys in `map` are dotted protocol fields: for jobs `id`, `title`, `org`, `summary`, `description`, `url`, `posted_at`, `expires_at`, `tags`, `apply_hint`, `pay.min`, `pay.max`, `pay.currency`, `pay.period` (`hour`, `day`, `week`, `month`, `year`, `unit`), `pay.unit`, `pay.text`, `location.text`, `location.country`, `location.remote`, `requirements.text`, `requirements.files`, `stages`, `raw`; for applications `id`, `job_id`, `job_title`, `stage`, `next`, `url`, `created_at`, `updated_at`, `files`, `progress`, `review`, `raw`. A map that names a field an application has no room for is refused when the profile loads; put extras under `raw`.

Timestamps are normalized to ISO 8601 (a timestamp without a zone is read as UTC), and rows that come out without an `id` and a `title` are skipped and logged.

### Errors

A tool result with `isError` becomes a `ProtocolError`. The code comes from `errors` in the profile (`{ "sign_in_required": "auth_required" }`, keyed by the result's `code` or `error` field) or, failing that, from the message: not found, sign in, rate limit, already, invalid. Transport failures and HTTP 401 become `auth_required` with the profile's `help`; an unknown tool becomes `not_supported`.

## Drafting one

```bash
work mcp inspect https://acme.example/mcp              # the tools and their inputs
work draft https://acme.example/mcp --query gigs --out src/connectors
```

`work draft` guesses the stages from the tool names, the arguments from the input schemas, and the fields from a sample search. It writes `src/connectors/acme/profile.ts` and `index.ts`; every guess is marked `TODO`. Finish the map, then:

1. Capture one real result per read tool with `work mcp call acme list_gigs '{"limit":3}' --json`, trim it, and save it under `fixtures/`. Reads only: never run a write tool against a real platform from tests.
2. Write `index.test.ts` on the fake server (below), register the connector in `src/connectors/index.ts`, add the folder's `README.md` and a row in `docs/catalog.md`, and list any key in `.env.example`.

## Testing with the fake server

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, testContext } from "../../core/conformance.js";
import { McpClientPool } from "../../core/mcpClient.js";
import { defineMcpConnector } from "../../core/mcp/profile.js";
import { createFakeMcp } from "../../../tests/helpers/fakeMcpServer.js";
import { acme } from "./index.js";
import { profile } from "./profile.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const fake = createFakeMcp(
  {
    list_gigs: () => fixture("list_gigs"), // an object answers as structuredContent
    get_gig: () => ({ text: JSON.stringify(fixture("get_gig")) }), // JSON in text, if that is what the server does
    claim_gig: (args) => ({ claimed: args.gig_id }),
  },
  { requireAuth: ["claim_gig"] }, // answers "sign in" without a bearer
);
const offline = defineMcpConnector(profile, { pool: new McpClientPool({ transportFactory: fake.transportFactory }) });

describeConnectorConformance(process.env.LIVE === "1" ? acme : offline, { search: profile.sample, expectFetch: false, minResults: 1 });

describe("acme mapping", () => {
  it("maps the first result", async () => {
    const { jobs } = await offline.search!(profile.sample, testContext());
    expect(jobs[0]).toMatchObject({ id: "g1", kind: "task", title: "Label 50 images" });
  });
});
```

`fake.calls` and `fake.lastCall("tool")` show what the profile sent. The conformance suite checks the contract; `npm run test:live -- src/connectors/acme` runs the same search against the real server. An OAuth server is tested with `oauthProvider: () => ({ tokens: () => ({ access_token: "t", token_type: "bearer" }) }) as never` on the signed-in connector, and `validTokens: ["t"]` on the fake.

## Calling the rest of a server

A profile maps the stages; the server's other tools stay reachable: `work mcp call acme register '{"name":"my agent"}'` runs any tool as you, and `connector.callTool(tool, args, ctx)` does the same from code (`isMcpLinked(connector)` tells a linked connector apart).
