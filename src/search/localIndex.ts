/**
 * The index without a database: rows in memory, optionally kept in a JSON file, ranked with BM25
 * over weighted fields and, when rows carry embeddings, cosine similarity, fused by reciprocal rank.
 * Used by the CLI (`work index`, then `work search`) and by tests. Same answers as match_work_index
 * in spirit, not to the decimal.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cosine, type Embedder } from "./embed.js";
import type { IndexHit, IndexQuery, IndexRow, IndexStore } from "./types.js";

type Stored = IndexRow & { first_seen: string; last_seen: string; closed_at?: string };

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "with",
  "at",
  "by",
  "is",
  "are",
  "be",
  "your",
  "you",
  "our",
]);
const FIELD_WEIGHTS = { title: 3, skills: 3, org: 1.5, tags: 1.5, summary: 1, description: 0.5 } as const;
const RRF_K = 50;

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .split(/[^a-z0-9+#]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** A light English stemmer: enough that "bounties" finds "bounty" and "labeling" finds "label". */
export function stem(t: string): string {
  if (t.length <= 3) return t;
  if (t.endsWith("ies") && t.length > 4) return `${t.slice(0, -3)}y`;
  if (t.endsWith("ing") && t.length > 5) return t.slice(0, -3).replace(/(ll|nn|tt|pp)$/u, (m) => m[0]!);
  if (t.endsWith("ers") && t.length > 5) return t.slice(0, -3);
  if (t.endsWith("er") && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("es") && /(ss|x|ch|sh)es$/u.test(t)) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function fieldText(row: IndexRow, field: keyof typeof FIELD_WEIGHTS): string {
  if (field === "skills") return row.skills.join(" ");
  if (field === "tags") return row.tags.join(" ");
  return (row[field] ?? "").slice(0, field === "description" ? 4000 : undefined);
}

export type LocalIndexOptions = {
  /** JSON file to keep rows in. Omit for memory only. */
  file?: string;
  embedder?: Embedder;
  /** Rows refreshed within this many hours count as covered. Default 6. */
  freshHours?: number;
  now?: () => number;
};

export class LocalIndex implements IndexStore {
  private rows = new Map<string, Stored>();
  private readonly now: () => number;
  constructor(private readonly options: LocalIndexOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.file) {
      try {
        const saved = JSON.parse(readFileSync(options.file, "utf8")) as Stored[];
        for (const row of saved) this.rows.set(row.id, row);
      } catch {
        // no file yet
      }
    }
  }

  get size(): number {
    return [...this.rows.values()].filter((r) => !r.closed_at).length;
  }

  private save(): void {
    if (!this.options.file) return;
    mkdirSync(path.dirname(this.options.file), { recursive: true });
    writeFileSync(this.options.file, JSON.stringify([...this.rows.values()]), { mode: 0o600 });
  }

  async coverage(): Promise<Set<string>> {
    const cutoff = this.now() - (this.options.freshHours ?? 6) * 3_600_000;
    const covered = new Set<string>();
    for (const row of this.rows.values()) if (!row.closed_at && Date.parse(row.last_seen) >= cutoff) covered.add(row.connector_id);
    return covered;
  }

  async unembedded(ids: string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.rows.has(id) && !this.rows.get(id)!.embedding));
  }

  async hashes(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) out.set(id, row.content_hash);
    }
    return out;
  }

  async upsert(rows: IndexRow[]): Promise<void> {
    const at = new Date(this.now()).toISOString();
    for (const row of rows) {
      const before = this.rows.get(row.id);
      const embedding = row.embedding ?? (before?.content_hash === row.content_hash ? before.embedding : undefined);
      const next: Stored = { ...row, first_seen: before?.first_seen ?? at, last_seen: at };
      if (embedding) next.embedding = embedding;
      else delete next.embedding;
      this.rows.set(row.id, next);
    }
    this.save();
  }

  async forget(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row && !row.closed_at) {
      row.closed_at = new Date(this.now()).toISOString();
      this.save();
    }
  }

  async closeStale(connectorId: string, olderThan: string): Promise<number> {
    const cutoff = Date.parse(olderThan);
    const at = new Date(this.now()).toISOString();
    let closed = 0;
    for (const row of this.rows.values()) {
      if (row.connector_id === connectorId && !row.closed_at && Date.parse(row.last_seen) < cutoff) {
        row.closed_at = at;
        closed += 1;
      }
    }
    if (closed) this.save();
    return closed;
  }

  async embed(text: string): Promise<number[] | undefined> {
    if (!this.options.embedder || !text.trim()) return undefined;
    try {
      return (await this.options.embedder([text]))[0];
    } catch {
      return undefined;
    }
  }

  async search(query: IndexQuery): Promise<IndexHit[]> {
    const now = this.now();
    const open = [...this.rows.values()].filter(
      (r) =>
        !r.closed_at &&
        (!r.expires_at || Date.parse(r.expires_at) > now) &&
        (!query.connectors || query.connectors.includes(r.connector_id)) &&
        (!query.kinds || query.kinds.includes(r.kind)) &&
        (!query.categories || (r.category !== undefined && query.categories.includes(r.category))) &&
        (!query.fiatOnly || r.fiat) &&
        (query.minPayUsd === undefined || (r.pay_usd ?? 0) >= query.minPayUsd) &&
        (!query.remoteOnly || r.remote !== false) &&
        (!query.postedAfter || (r.posted_at ? r.posted_at.slice(0, 10) >= query.postedAfter : Boolean(r.expires_at))),
    );
    const terms = [...new Set(tokens(query.text))];
    const ranks: Map<string, number>[] = [];
    const textHits = new Set<string>();
    const similarity = new Map<string, number>();

    if (terms.length) {
      // BM25 per field, summed with field weights.
      const fields = Object.keys(FIELD_WEIGHTS) as (keyof typeof FIELD_WEIGHTS)[];
      const docs = open.map((row) => fields.map((f) => tokens(fieldText(row, f))));
      const avg = fields.map((_, i) => docs.reduce((s, d) => s + d[i]!.length, 0) / Math.max(1, docs.length) || 1);
      const df = new Map<string, number>();
      for (const d of docs) {
        const present = new Set(d.flat());
        for (const t of terms) if (present.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
      }
      const scored = open.map((row, i) => {
        let score = 0;
        for (const t of terms) {
          const n = df.get(t) ?? 0;
          if (!n) continue;
          const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
          fields.forEach((f, fi) => {
            const field = docs[i]![fi]!;
            const tf = field.filter((x) => x === t).length;
            if (!tf) return;
            score += FIELD_WEIGHTS[f] * idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (field.length / avg[fi]!))));
          });
        }
        return { id: row.id, score };
      });
      const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      hits.forEach((h) => textHits.add(h.id));
      ranks.push(new Map(hits.slice(0, 200).map((h, i) => [h.id, i + 1])));
    }
    if (query.embedding) {
      const sims = open
        .filter((r) => r.embedding)
        .map((r) => ({ id: r.id, sim: cosine(query.embedding!, r.embedding!) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 200);
      sims.forEach((s) => similarity.set(s.id, s.sim));
      ranks.push(new Map(sims.map((s, i) => [s.id, i + 1])));
    }
    if (!ranks.length) {
      const newest = [...open].sort(
        (a, b) => Date.parse(b.posted_at ?? b.first_seen) - Date.parse(a.posted_at ?? a.first_seen) || a.id.localeCompare(b.id),
      );
      ranks.push(new Map(newest.slice(0, 200).map((r, i) => [r.id, i + 1])));
    }

    const fused = new Map<string, number>();
    for (const rank of ranks) for (const [id, r] of rank) fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + r));
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(query.offset, query.offset + query.limit)
      .map(([id, score]) => {
        const row = this.rows.get(id)!;
        const hit: IndexHit = { job: row.job, score, textHit: textHits.has(id) };
        const sim = similarity.get(id);
        if (sim !== undefined) hit.similarity = sim;
        if (row.pay_usd !== undefined) hit.pay_usd = row.pay_usd;
        return hit;
      });
  }
}
