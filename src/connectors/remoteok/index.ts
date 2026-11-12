import { defineJsonBoard, iso, num, str, strings } from "../../core/jsonBoard.js";
import { stripHtml } from "../../core/text.js";
import type { NativeJob } from "../../core/types.js";

type Row = Record<string, unknown>;

function record(value: unknown): Row | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
}

function remoteOkUrl(value: unknown): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || !["remoteok.com", "www.remoteok.com"].includes(url.hostname.toLowerCase())) return undefined;
    url.hostname = "remoteok.com";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function salaryText(row: Row): string | undefined {
  const minimum = num(row.salary_min);
  const maximum = num(row.salary_max);
  const low = minimum !== undefined && minimum > 0 ? minimum : undefined;
  const high = maximum !== undefined && maximum > 0 ? maximum : undefined;
  if (low === undefined && high === undefined) return undefined;

  const currency = str(row.salary_currency)?.toUpperCase();
  const format = (amount: number) => amount.toLocaleString("en-US");
  const range =
    low !== undefined && high !== undefined
      ? low === high
        ? format(low)
        : `${format(low)}–${format(high)}`
      : low !== undefined
        ? `from ${format(low)}`
        : `up to ${format(high!)}`;
  return `${currency ? `${currency} ` : ""}${range}${currency ? "" : " (currency not specified)"}`;
}

/** Map one Remote OK feed row while retaining a direct link to its original posting. */
export function mapRemoteOkJob(value: unknown): NativeJob | null {
  const row = record(value);
  const id = row?.id === undefined || row.id === null ? undefined : String(row.id);
  const title = str(row?.position);
  const url = remoteOkUrl(row?.url);
  if (!row || !id || !title || !url) return null;

  const description = str(row.description);
  const location = str(row.location);
  const salary = salaryText(row);
  const tags = strings(row.tags)
    .map((tag) => tag.trim())
    .filter(Boolean);

  return {
    id,
    kind: "listing",
    title,
    ...(str(row.company) ? { org: str(row.company) } : {}),
    location: { ...(location ? { text: location } : {}), remote: true },
    ...(salary ? { pay: { text: salary } } : {}),
    ...(description ? { summary: stripHtml(description, 300), description: stripHtml(description, 6000) } : {}),
    url,
    ...(iso(row.date) ? { posted_at: iso(row.date) } : {}),
    tags: [...tags.slice(0, 8), "source:remoteok"],
    apply_hint: "Apply through the original Remote OK listing and follow the employer's stated application requirements.",
  };
}

/** Remote OK's public, read-only JSON feed. Jobs link back to Remote OK as required by its feed terms. */
export const remoteok = defineJsonBoard({
  id: "remoteok",
  name: "Remote OK",
  description: "Remote job listings from Remote OK. Find and read only; each result links to its original listing.",
  homepage: "https://remoteok.com",
  request: () => new URL("https://remoteok.com/api"),
  rows: (body) => {
    if (!Array.isArray(body)) throw new TypeError("Remote OK answered with an unexpected feed shape.");
    return body.filter((value) => {
      const row = record(value);
      return row?.id !== undefined && row.id !== null && Boolean(str(row.position));
    });
  },
  map: mapRemoteOkJob,
  // The endpoint returns the full feed; local query and location filters keep results precise.
  applies: { remote: true },
  // Avoid repeatedly downloading the public feed during a short search session.
  cacheTtlMs: 5 * 60_000,
});
