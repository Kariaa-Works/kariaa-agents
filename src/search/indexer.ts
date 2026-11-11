/**
 * Fills the index: for every catalog platform whose listings are public, search broadly, normalise,
 * embed what changed, upsert, and close what hasn't been seen for a day.
 */
import { toProtocolError } from "../core/errors.js";
import type { ConnectorInfo, WorkProtocol } from "../core/router.js";
import type { Job } from "../core/types.js";
import type { Embedder } from "./embed.js";
import { embeddingText, FALLBACK_USD_RATES, toIndexRow } from "./normalize.js";
import type { IndexStore } from "./types.js";

/** Broad queries that widen what a 50-row page covers on large platforms. */
export const SEED_QUERIES = [
  "developer",
  "python",
  "javascript",
  "data",
  "machine learning",
  "design",
  "writing",
  "video",
  "security",
  "research",
  "smart contract",
  "forecasting",
];

const PAGE = 50;

export type IndexReport = {
  connector: string;
  seen: number;
  changed: number;
  closed: number;
  error?: string;
};

export type IndexerOptions = {
  protocol: WorkProtocol;
  store: IndexStore;
  embedder?: Embedder;
  rates?: Record<string, number>;
  /** Only these connectors. Default: every indexable one. */
  connectors?: string[];
  /** Rows not seen for this long are closed. Default 24 h. */
  staleHours?: number;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

/**
 * In the catalog, searchable, and listing work (selling platforms list your own goods): without an account, or
 * with a read key the server holds (NEAR_AGENT_MARKET_TOKEN, KAGGLE_*). Server keys reach only the indexer;
 * each person's requests get their own vault, never the server's environment.
 */
export function indexable(info: ConnectorInfo): boolean {
  return (
    info.tier !== undefined &&
    !info.opt_in &&
    info.stages.includes("search") &&
    info.category !== "selling" &&
    (info.auth.type === "none" || !info.auth.required || info.auth.configured)
  );
}

/** Every open listing the platform shows, and whether that is all of them (one short page with nothing more). */
async function gather(protocol: WorkProtocol, id: string): Promise<{ jobs: Job[]; complete: boolean }> {
  const byId = new Map<string, Job>();
  const run = async (query?: string) => {
    const result = await protocol.search({ connectors: [id], limit: PAGE, ...(query ? { query } : {}) });
    const failed = result.partial.find((p) => p.connector === id);
    if (failed) throw new Error(`${failed.error.code}: ${failed.error.message}`);
    for (const job of result.jobs) byId.set(job.id, job);
    return result;
  };
  const first = await run();
  const complete = first.jobs.length > 0 && first.jobs.length < PAGE && !first.more;
  if (!complete) {
    for (const seed of SEED_QUERIES) {
      try {
        await run(seed);
      } catch {
        // one seed failing doesn't lose the others
      }
    }
  }
  return { jobs: [...byId.values()], complete };
}

export async function indexCatalog(options: IndexerOptions): Promise<IndexReport[]> {
  const { protocol, store } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const rates = options.rates ?? FALLBACK_USD_RATES;
  const infos = protocol.connectors().filter((c) => (options.connectors ? options.connectors.includes(c.id) : indexable(c)));
  const reports: IndexReport[] = [];

  for (const info of infos) {
    const report: IndexReport = { connector: info.id, seen: 0, changed: 0, closed: 0 };
    try {
      const started = now();
      const { jobs, complete } = await gather(protocol, info.id);
      const rows = jobs.map((job) =>
        toIndexRow(
          job,
          { ...(info.category ? { category: info.category } : {}), ...(info.payout_rails ? { payoutRails: info.payout_rails } : {}) },
          rates,
        ),
      );
      const before = await store.hashes(rows.map((r) => r.id));
      const changed = rows.filter((r) => before.get(r.id) !== r.content_hash);
      // Changed rows, and rows indexed before an embedder was set, get an embedding.
      const missing = options.embedder && store.unembedded ? await store.unembedded(rows.map((r) => r.id)) : new Set<string>();
      const toEmbed = rows.filter((r) => before.get(r.id) !== r.content_hash || missing.has(r.id));
      if (options.embedder && toEmbed.length) {
        try {
          const vectors = await options.embedder(toEmbed.map(embeddingText));
          toEmbed.forEach((row, i) => {
            if (vectors[i]) row.embedding = vectors[i];
          });
        } catch (error) {
          log("index.embed_failed", { connector: info.id, message: error instanceof Error ? error.message : String(error) });
        }
      }
      await store.upsert(rows);
      report.seen = rows.length;
      report.changed = changed.length;
      // Close only after a run that saw something: an outage must not empty the index. A run that saw the whole
      // list closes what it didn't see now; a partial one (pages vary) only what went unseen for staleHours.
      if (rows.length) {
        const cutoff = complete ? started : now() - (options.staleHours ?? 24) * 3_600_000;
        report.closed = await store.closeStale(info.id, new Date(cutoff).toISOString());
      }
    } catch (error) {
      report.error = toProtocolError(error, info.id).message;
    }
    log("index.connector", { ...report });
    reports.push(report);
  }
  return reports;
}
