/**
 * The search index: public listings from the catalog platforms, gathered ahead of time by the
 * indexer, so a search answers from one ranked store instead of asking every platform live.
 */
import type { ConnectorCategory, Job, JobKind } from "../core/types.js";

/** One indexed listing. `job` is what search returns; the rest is for filtering and ranking. */
export type IndexRow = {
  id: string;
  connector_id: string;
  kind: JobKind;
  category?: ConnectorCategory;
  title: string;
  org?: string;
  summary?: string;
  description?: string;
  skills: string[];
  tags: string[];
  location_text?: string;
  remote?: boolean;
  pay_min?: number;
  pay_max?: number;
  currency?: string;
  pay_period?: string;
  /** Best known amount in USD, per `pay_period`. */
  pay_usd?: number;
  payout_rails: string[];
  fiat: boolean;
  participation_mode?: string;
  stages: string[];
  url?: string;
  posted_at?: string;
  expires_at?: string;
  job: Job;
  content_hash: string;
  dedupe_key: string;
  embedding?: number[];
};

export type IndexQuery = {
  /** Words left after the filters were taken out. Empty: newest first. */
  text: string;
  embedding?: number[];
  connectors?: string[];
  kinds?: JobKind[];
  categories?: ConnectorCategory[];
  fiatOnly?: boolean;
  minPayUsd?: number;
  remoteOnly?: boolean;
  /** Only rows posted on or after this date (YYYY-MM-DD); undated rows count while they have a closing date ahead. */
  postedAfter?: string;
  limit: number;
  offset: number;
};

export type IndexHit = { job: Job; score: number; similarity?: number; textHit: boolean; pay_usd?: number };

export interface SearchIndex {
  /** Connectors with listings refreshed recently enough to answer from the index. */
  coverage(): Promise<Set<string>>;
  search(query: IndexQuery): Promise<IndexHit[]>;
  /** Turns query text into an embedding, when the index has an embedder. */
  embed?(text: string): Promise<number[] | undefined>;
  /** Marks a listing closed now, when its platform says it is gone (instead of waiting for the next refresh). */
  forget?(id: string): Promise<void>;
}

/** What the indexer writes through. */
export interface IndexStore extends SearchIndex {
  /** content_hash by id, for the ids given: unchanged rows keep their embedding. */
  hashes(ids: string[]): Promise<Map<string, string>>;
  /** Of the ids given, the stored rows with no embedding yet (indexed before an embedder was set). */
  unembedded?(ids: string[]): Promise<Set<string>>;
  upsert(rows: IndexRow[]): Promise<void>;
  /** Marks this connector's open rows last seen before `olderThan` (ISO time) as closed. Returns how many. */
  closeStale(connectorId: string, olderThan: string): Promise<number>;
}
