import { defineJsonBoard, iso, str, strings } from "../../core/jsonBoard.js";
import { stripHtml } from "../../core/text.js";

type Row = Record<string, unknown>;

/** Remotive's public API. Jobs are delayed 24 h; results link back to Remotive, which asks to be credited as the source. */
export const remotive = defineJsonBoard({
  id: "remotive",
  name: "Remotive",
  description: "Remote jobs from Remotive, worldwide and by region. Find only.",
  homepage: "https://remotive.com",
  request: (query) => {
    const url = new URL("https://remotive.com/api/remote-jobs");
    if (query.query?.trim()) url.searchParams.set("search", query.query.trim());
    url.searchParams.set("limit", String(Math.min(100, (query.limit ?? 20) * 2)));
    return url;
  },
  rows: (body) => (body as { jobs?: unknown[] }).jobs ?? [],
  map: (row) => {
    const r = row as Row;
    const title = str(r.title);
    if (r.id === undefined || r.id === null || !title) return null;
    const description = str(r.description);
    const location = str(r.candidate_required_location);
    return {
      id: String(r.id),
      kind: "listing",
      title,
      ...(str(r.company_name) ? { org: str(r.company_name) } : {}),
      location: { ...(location ? { text: location } : {}), remote: true },
      ...(str(r.salary) ? { pay: { text: str(r.salary) } } : {}),
      ...(description ? { summary: stripHtml(description, 300), description: stripHtml(description, 6000) } : {}),
      ...(str(r.url) ? { url: str(r.url) } : {}),
      ...(iso(r.publication_date) ? { posted_at: iso(r.publication_date) } : {}),
      tags: [str(r.category), str(r.job_type), ...strings(r.tags).slice(0, 8), "source:remotive"].filter((t): t is string => Boolean(t)),
    };
  },
  // The API takes `search` but has stopped filtering by it, so the words are matched here.
  applies: { remote: true },
});
