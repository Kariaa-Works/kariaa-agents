/**
 * A job board with a JSON search API, in a few declarative lines. The helper
 * owns the request, the error mapping, row validation and the filters the API
 * does not apply itself.
 */
import { defineConnector, type AuthSpec, type Connector, type ConnectorContext } from "./connector.js";
import { ProtocolError, toProtocolError } from "./errors.js";
import { queryWords } from "./text.js";
import { parseFeed, type Feed } from "./feed.js";
import { NativeJobSchema, type ConnectorCategory, type JobKind, type NativeJob, type PayoutRail, type SearchQuery } from "./types.js";
import { USER_AGENT } from "./version.js";

/** A request with more than a URL: a POST body, or headers built from the credentials. */
export type BoardRequest = { url: URL | string; method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string> };

export type JsonBoard = {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  auth?: AuthSpec;
  /** What the board lists. Default `["listing"]`; bounty and gig feeds say `["task"]`. */
  kinds?: JobKind[];
  /** How the source pays (see Connector.category). Default `job`. */
  category?: ConnectorCategory;
  /** Where the money lands. Default `["employer"]`. */
  payoutRails?: PayoutRail[];
  /** Searched only when named (see Connector.optIn). */
  optIn?: boolean;
  /** `xml` reads RSS, Atom or XML: `rows` then receives a parsed `Feed`. Default `json`. */
  format?: "json" | "xml";
  /** For `xml`: the element that holds one posting, when it is not `item` or `entry`. */
  itemTag?: string;
  /** The URL to GET for this query (or a request with a method, body and headers), or null when there is nothing to ask. */
  request(query: SearchQuery, credentials: Record<string, string | undefined>): URL | string | BoardRequest | null;
  headers?: Record<string, string>;
  /** The rows inside the response body. */
  rows(body: unknown): unknown[];
  /** One row as a job, or null to skip it. */
  map(row: unknown, query: SearchQuery): NativeJob | null;
  /** Whether the board has more than it returned. */
  more?(body: unknown, rows: unknown[]): boolean;
  /** The filters the API already applied through `request`; the others are applied here. */
  applies?: { query?: boolean; location?: boolean; remote?: boolean };
  /** Re-use the body for an identical URL this long, for feeds that ignore the query. */
  cacheTtlMs?: number;
};

type Cached = { at: number; body: unknown };

export function defineJsonBoard(board: JsonBoard): Connector {
  // One cache per fetch implementation, so hosts and tests that bring their own fetch never share bodies.
  const caches = new WeakMap<typeof fetch, Map<string, Cached>>();
  const cacheFor = (fetchImpl: typeof fetch): Map<string, Cached> => {
    let cache = caches.get(fetchImpl);
    if (!cache) {
      cache = new Map();
      caches.set(fetchImpl, cache);
    }
    return cache;
  };
  return defineConnector({
    id: board.id,
    name: board.name,
    description: board.description,
    homepage: board.homepage,
    kinds: board.kinds ?? ["listing"],
    category: board.category ?? "job",
    payoutRails: board.payoutRails ?? ["employer"],
    ...(board.optIn ? { optIn: true } : {}),
    auth: board.auth ?? { type: "none" },
    async search(query, ctx) {
      const target = board.request(query, ctx.credentials);
      if (!target) return { jobs: [] };
      const request: BoardRequest = typeof target === "string" || target instanceof URL ? { url: target } : target;
      const body = await fetchBody(board, request, ctx, cacheFor(ctx.fetch));
      let rows: unknown[];
      try {
        rows = board.rows(body);
      } catch (error) {
        throw new ProtocolError("upstream_error", `${board.name} answered in an unexpected shape.`, { connector: board.id, cause: error });
      }
      if (!Array.isArray(rows)) {
        throw new ProtocolError("upstream_error", `${board.name} answered in an unexpected shape.`, { connector: board.id });
      }
      const jobs: NativeJob[] = [];
      for (const row of rows) {
        let job: NativeJob | null;
        try {
          job = board.map(row, query);
        } catch (error) {
          ctx.log("board.row_skipped", { connector: board.id, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (!job) continue;
        const parsed = NativeJobSchema.safeParse(job);
        if (!parsed.success) {
          ctx.log("board.row_invalid", {
            connector: board.id,
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
          continue;
        }
        jobs.push(parsed.data);
      }
      const filtered = applyFilters(jobs, query, board.applies ?? {});
      const limit = query.limit ?? 20;
      const more = (board.more?.(body, rows) ?? false) || filtered.length > limit;
      return { jobs: filtered.slice(0, limit), more };
    },
  });
}

async function fetchBody(board: JsonBoard, request: BoardRequest, ctx: ConnectorContext, cache: Map<string, Cached>): Promise<unknown> {
  const url = String(request.url);
  const method = request.method ?? (request.body === undefined ? "GET" : "POST");
  const payload = request.body === undefined ? undefined : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  const key = `${method} ${url} ${payload ?? ""}`;
  const ttl = board.cacheTtlMs ?? 0;
  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.body;
  }
  const xml = board.format === "xml";
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method,
      headers: {
        accept: xml ? "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8" : "application/json",
        "user-agent": USER_AGENT,
        ...(payload !== undefined && typeof request.body !== "string" ? { "content-type": "application/json" } : {}),
        ...board.headers,
        ...request.headers,
      },
      ...(payload !== undefined ? { body: payload } : {}),
      signal: ctx.signal,
    });
  } catch (error) {
    throw toProtocolError(error, board.id);
  }
  if ((response.status === 401 || response.status === 403) && board.auth && board.auth.type !== "none") {
    throw new ProtocolError("auth_required", `${board.name} refused the credentials. ${board.auth.help}`, {
      connector: board.id,
      details: { status: response.status },
    });
  }
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    throw new ProtocolError("rate_limited", `${board.name} is rate limiting requests.`, {
      connector: board.id,
      retry_after: Number.isFinite(retry) && retry > 0 ? retry : 60,
    });
  }
  if (!response.ok) {
    throw new ProtocolError("upstream_error", `${board.name} answered ${response.status}.`, {
      connector: board.id,
      details: { status: response.status },
    });
  }
  let body: unknown;
  try {
    body = xml ? (parseFeed(await response.text(), board.itemTag) satisfies Feed) : await response.json();
  } catch (error) {
    throw new ProtocolError("upstream_error", `${board.name} did not answer with ${xml ? "a feed" : "JSON"}.`, {
      connector: board.id,
      cause: error,
    });
  }
  if (ttl > 0) cache.set(key, { at: Date.now(), body });
  return body;
}

/** Keeps jobs whose location names the place, or says anywhere, or is unknown. */
export function locationFits(job: NativeJob, place: string): boolean {
  const text = `${job.location?.text ?? ""} ${job.location?.country ?? ""}`.trim().toLowerCase();
  if (!text) return true;
  if (text.includes(place)) return true;
  return /\b(worldwide|anywhere|global|international|remote)\b/u.test(text);
}

const QUERY_STOPWORDS = new Set([
  "job",
  "jobs",
  "role",
  "roles",
  "position",
  "positions",
  "opening",
  "openings",
  "work",
  "remote",
  "for",
  "and",
  "the",
  "with",
  "in",
  "at",
  "of",
  "to",
  "a",
  "an",
]);

export function applyFilters(jobs: NativeJob[], query: SearchQuery, applies: NonNullable<JsonBoard["applies"]>): NativeJob[] {
  let out = jobs;
  const words = queryWords(query.query);
  if (words.length > 0 && !applies.query) {
    const significant = words.filter((w) => !QUERY_STOPWORDS.has(w));
    const activeWords = significant.length > 0 ? significant : words;
    const minMatched = activeWords.length <= 3 ? activeWords.length : Math.max(2, Math.ceil(activeWords.length * 0.6));
    const scored: Array<{ job: NativeJob; score: number }> = [];
    for (const job of out) {
      const titleHay = job.title.toLowerCase();
      const hay = [job.title, job.org, job.summary, job.description, ...(job.tags ?? []).filter((tag) => !tag.startsWith("source:"))]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const matched = activeWords.filter((word) => hay.includes(word));
      const titleMatched = activeWords.filter((word) => titleHay.includes(word));
      if (matched.length >= minMatched) {
        const allMatchedBonus = matched.length === activeWords.length ? 100 : 0;
        scored.push({
          job,
          score: allMatchedBonus + titleMatched.length * 10 + matched.length,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    out = scored.map((entry) => entry.job);
  }
  const place = query.location?.trim().toLowerCase();
  if (place && !applies.location) out = out.filter((job) => locationFits(job, place));
  if (query.remote === true && !applies.remote) out = out.filter((job) => job.location?.remote === true);
  if (query.pay_min !== undefined) {
    out = out.filter((job) => (job.pay?.max ?? job.pay?.min ?? 0) >= query.pay_min!);
  }
  if (query.currency && query.currency.trim().length > 0) {
    const wantedCurrency = query.currency.trim().toUpperCase();
    out = out.filter((job) => job.pay?.currency?.toUpperCase() === wantedCurrency);
  }
  if (query.direct_apply === true) {
    out = out.filter((job) => job.participation_mode === "direct_apply" || (job.stages ?? []).includes("apply"));
  }
  return out;
}

/** A string field of a row, or undefined. */
export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u;

/** ISO 8601 from a date string or epoch seconds, or undefined. A timestamp without a zone is read as UTC. */
export function iso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    const t = Date.parse(NAIVE_DATETIME.test(text) ? `${text.replace(" ", "T")}Z` : text);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  return undefined;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

/** A board that publishes RSS, Atom or XML: `rows` defaults to the feed's items. */
export function defineFeedBoard(board: Omit<JsonBoard, "format" | "rows"> & { rows?: JsonBoard["rows"] }): Connector {
  return defineJsonBoard({ ...board, format: "xml", rows: board.rows ?? ((body) => (body as Feed).items) });
}
