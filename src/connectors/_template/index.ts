/**
 * A connector for a job board with a JSON search API, in declarative form.
 *
 * `npm run new-connector -- <id>` made this folder. Fill in the TODOs, capture
 * one real response as `fixtures/search.json`, run `npm test`, and register the
 * connector in `src/connectors/index.ts` (import, list and export block). See docs/connectors.md for the contract, and
 * src/core/connector.ts for the full interface when a source supports more
 * than finding (apply, upload, submit, status).
 */
import { defineJsonBoard, iso, str, strings } from "../../core/jsonBoard.js";
import { stripHtml } from "../../core/text.js";

type Row = Record<string, unknown>;

export const exampleBoard = defineJsonBoard({
  // TODO: lowercase letters, digits and dashes. Every id this connector returns is prefixed with it.
  id: "example-board",
  name: "Example Board",
  description: "What it covers, where, and that it is find only.",
  homepage: "https://example.com",
  // TODO: delete `auth` for a keyless API, or name the env vars a person must set.
  // auth: { type: "api_key", env: ["EXAMPLE_API_KEY"], help: "Keys at https://example.com/developers" },

  // The URL to GET. Return null when there is nothing to ask (for example the API needs a query).
  request: (query, _credentials) => {
    const url = new URL("https://example.com/api/jobs");
    if (query.query?.trim()) url.searchParams.set("q", query.query.trim());
    url.searchParams.set("limit", String(query.limit ?? 20));
    return url;
  },

  // The array of postings inside the response body.
  rows: (body) => (body as { jobs?: unknown[] }).jobs ?? [],

  // One posting as a job. Return null to skip a row. Ids are the source's own.
  map: (row) => {
    const r = row as Row;
    const id = str(r.id);
    const title = str(r.title);
    if (!id || !title) return null;
    return {
      id,
      kind: "listing",
      title,
      ...(str(r.company) ? { org: str(r.company) } : {}),
      location: { ...(str(r.location) ? { text: str(r.location) } : {}), remote: r.remote === true },
      ...(str(r.description) ? { summary: stripHtml(str(r.description), 300), description: stripHtml(str(r.description), 6000) } : {}),
      ...(str(r.url) ? { url: str(r.url) } : {}),
      ...(iso(r.posted) ? { posted_at: iso(r.posted) } : {}),
      tags: [...strings(r.tags), "source:example-board"],
    };
  },

  // Which filters the API applied through `request`. The others run here on the rows.
  applies: { query: true },
});
