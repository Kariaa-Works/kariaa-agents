/**
 * The unified API. One object, every stage, any registered connector.
 * Ids in are `<connector>:<native>`; ids out are the same. Connectors see only
 * their native ids.
 */
import { connectPlan, saveableNames, type Connection, type CredentialStore } from "./connect.js";
import {
  ACTION_STAGES,
  hasStage,
  stagesOf,
  type CatalogTier,
  type Connector,
  type ConnectorContext,
  type Logger,
  type ProfileField,
  type RegisterInput,
} from "./connector.js";
import { canUse, credentialsFor, isConfigured, type CredentialOverrides } from "./credentials.js";
import { ProtocolError, toProtocolError } from "./errors.js";
import { resolveWork, type Lookup } from "./files.js";
import { makeId, parseId } from "./ids.js";
import { PayConfirm } from "./payConfirm.js";
import { JobCache } from "./jobCache.js";
import { dedupeKey } from "./dedupe.js";
import { type ConnectorHealth, type HealthStatus } from "./health.js";
import { Registry } from "./registry.js";
import { FALLBACK_USD_RATES, payUsd } from "../search/normalize.js";
import { stem } from "../search/localIndex.js";
import type { IndexHit, SearchIndex } from "../search/types.js";
import { understand } from "../search/understand.js";
import { runAsTenant } from "./tenant.js";
import { verifyWork, type Verification, type Verifier } from "./verifier.js";
import {
  ApplyInputSchema,
  PayoutInputSchema,
  PostInputSchema,
  ReviewInputSchema,
  PayInputSchema,
  PostingSchema,
  PaymentSchema,
  OfferSchema,
  SearchQuerySchema,
  type Account,
  type Application,
  type ApplyInput,
  type ConnectorCategory,
  type Earnings,
  type Job,
  type JobKind,
  type Link,
  type NativeApplication,
  type NativeEarnings,
  type NativeJob,
  type NativePayout,
  type PartialFailure,
  type Payout,
  type PayoutInput,
  type PostInput,
  type ReviewInput,
  type PayInput,
  type Posting,
  type Payment,
  type Offer,
  type NativePosting,
  type NativePayment,
  type PayoutRail,
  type SearchQuery,
  type SearchResult,
  type Stage,
  type WorkInput,
  type WorkReceipt,
} from "./types.js";
import type { ZodType } from "zod";

export type ConnectorInfo = {
  /** true: searched only when named. */
  opt_in?: boolean;
  /** Set: in the curated catalog. managed / self: the agent acts there; discover: listings only. */
  tier?: CatalogTier;
  /** true: every action waits for the person's yes. */
  ask_first?: boolean;
  /** down: the platform failed its last searches and is left out of catalog searches until it answers again. */
  health?: HealthStatus;
  id: string;
  name: string;
  description: string;
  homepage?: string;
  kinds: JobKind[];
  /** How the source pays: bounty, micro_task, selling, competition or job. */
  category?: ConnectorCategory;
  /** Where the money lands: fiat, crypto, employer. */
  payout_rails?: PayoutRail[];
  stages: Stage[];
  auth: { type: "none" | "api_key" | "oauth"; configured: boolean; required: boolean; env?: string[]; help?: string };
  profileFields?: ProfileField[];
};

export type WorkProtocolOptions = {
  registry?: Registry;
  connectors?: Connector[];
  env?: NodeJS.ProcessEnv;
  /** Credentials by connector id, taking precedence over the environment. */
  credentials?: CredentialOverrides;
  fetch?: typeof fetch;
  log?: Logger;
  /** Shared record of which platforms are answering; one per server. Unset: every platform is always asked. */
  health?: ConnectorHealth;
  /** Per-connector budget for a search. Default `WORK_SEARCH_TIMEOUT_MS` or 40 s. */
  searchTimeoutMs?: number;
  /** Budget for any other call. Default 60 s. */
  callTimeoutMs?: number;
  /** Budget for sending a file. Default 10 min. */
  uploadTimeoutMs?: number;
  /** Where searched jobs are kept for `get`. Default: memory only. */
  cache?: JobCache | null;
  /** Read `file.path` from disk. Default false. */
  allowLocalFiles?: boolean;
  maxFileBytes?: number;
  lookup?: Lookup;
  /** Verifiers `verify` runs. Default: none; `createProtocol` passes the built-in ones. */
  verifiers?: Verifier[];
  /** Optional default candidate profile for auto-filling ATS applications. */
  candidateProfile?: Record<string, string | undefined>;
  /** Where `saveCredentials` and `connect` keep keys. Values it loads count below the environment. */
  credentialStore?: CredentialStore;
  /** A page where the person connects a platform themselves (the hosted dashboard). */
  connectUrl?: (connectorId: string) => string | undefined;
  /** Who the calls are for when one process serves many people. Connectors keep their staged work apart per tenant. */
  tenant?: string;
  /**
   * "trusted": only the curated catalog (connectors with a tier) joins calls that don't name a connector. "all": every
   * connector that isn't opt-in. Default WORK_CATALOG, else "trusted" when any registered connector has a tier.
   */
  catalog?: "trusted" | "all";
  /** Answers searches over platforms it covers from a prebuilt index; the rest are asked live. */
  index?: SearchIndex;
  /** The secret behind payment confirm tokens. Left out: a fresh one, so tokens last as long as this object. */
  confirmSecret?: string;
};

/** Stages that belong to the account, not to one job. */
const SKIP_FOR_JOBS: ReadonlySet<Stage> = new Set([
  "search",
  "list",
  "account",
  "earnings",
  "payout",
  // the buying side is about your own postings, not about a job you found
  "post",
  "postings",
  "offers",
  "award",
  "review",
  "pay",
  "cancel",
]);

/** A small lift for the sources whose listings are checked hardest before they are shown. */
const TIER_1_CONNECTORS: ReadonlySet<string> = new Set(["kariaa", "kariaa-jobs"]);

const TIER_2_CONNECTORS: ReadonlySet<string> = new Set(["kaggle", "remotive", "yeswehack", "whop-bounties", "algora"]);

const ATS_CONNECTORS: ReadonlySet<string> = new Set(["greenhouse", "ashby", "lever", "recruitee", "manatal", "workable"]);

/** Multi-factor ranking score for a job against a search query. `payout` is the source's payout rails. */
export function scoreJob(job: Job, query: SearchQuery = {}, payout: readonly PayoutRail[] = []): number {
  let score = 0;
  const q = (query.query ?? "").trim().toLowerCase();
  if (q.length > 0) {
    const tokens = q.split(/[^a-z0-9+#.-]+/u).filter(Boolean);
    const title = job.title.toLowerCase();
    const orgAndTags = `${job.org ?? ""} ${(job.tags ?? []).join(" ")}`.toLowerCase();
    const desc = `${job.summary ?? ""} ${job.description ?? ""}`.toLowerCase();

    // A tag the source itself put on the listing ("security" on a bug bounty program) names its subject, like a title.
    const tagSet = new Set((job.tags ?? []).map((t) => t.toLowerCase()));
    if (title.includes(q)) score += 50;
    else if (tagSet.has(q)) score += 40;
    if (tokens.length > 1 && tokens.every((t) => title.includes(t))) score += 35;
    for (const token of tokens) {
      if (title.includes(token) || tagSet.has(token)) score += 12;
      else if (orgAndTags.includes(token)) score += 6;
      else if (desc.includes(token)) score += 3;
    }
    // A listing about every word of the query beats one that shares a single word, wherever the words sit.
    if (tokens.length > 1 && tokens.every((t) => title.includes(t) || orgAndTags.includes(t) || desc.includes(t))) score += 15;
  }

  if (TIER_1_CONNECTORS.has(job.connector)) score += 30;
  else if (TIER_2_CONNECTORS.has(job.connector)) score += 15;
  // Money that lands as ordinary currency beats money that lands only on chain.
  if (payout.includes("fiat")) score += 6;

  if (job.participation_mode === "direct_apply" || job.stages.includes("apply")) {
    score += 15;
  }

  const maxPay = job.pay?.max ?? job.pay?.min ?? 0;
  if (maxPay > 0) {
    score += 12;
  }

  if (job.posted_at) {
    const postedMs = Date.parse(job.posted_at);
    if (Number.isFinite(postedMs)) {
      const ageDays = (Date.now() - postedMs) / (1000 * 60 * 60 * 24);
      if (ageDays <= 14) score += 8;
    }
  }

  // Listed with a pay of zero: unpaid, whatever the label says.
  const listed = job.pay?.max ?? job.pay?.min;
  if (listed === 0) score -= 25;

  if (job.tags?.includes("unfunded") || job.tags?.includes("forum-reward")) {
    score -= 15;
  }

  return score;
}

/** Whole-word prefix match on the stem ("vulnerabilit" for both forms), so "python" finds "Python3" and "vulnerabilities" finds "vulnerability". */
const wordIn = (text: string, word: string, w = stem(word).replace(/(?<=\w{4})y$/u, "")) =>
  new RegExp(`(^|[^a-z0-9])${w.replace(/[.+#]/gu, (c) => `\\${c}`)}`, "u").test(text);

/**
 * Whether a live listing is about the words (whole-word prefix match, so "python" finds "Python3"): a title that
 * names one of them, or text that names all of one or two words and most of a longer query. One stray word in a long description is not enough.
 */
function mentions(job: Job, words: string[], indexed = false): boolean {
  if (words.some((w) => wordIn(job.title.toLowerCase(), w))) return true;
  const text =
    `${job.org ?? ""} ${(job.tags ?? []).join(" ")} ${job.summary ?? ""} ${(job.description ?? "").slice(0, 4000)}`.toLowerCase();
  const found = words.filter((w) => wordIn(text, w)).length;
  // The index already matched the words with stemming and ranks them: one of them in the text is enough there.
  if (indexed) return found >= 1;
  return words.length <= 2 ? found === words.length : found >= Math.ceil(words.length * 0.6);
}

/** Same title and pay from the same source: one listing posted twice. */
const repeatKey = (job: Job) => `${job.connector}|${job.title.toLowerCase().replace(/\s+/gu, " ").trim()}|${job.pay?.text ?? ""}`;

/** Platforms built for agents to take work on their own. */
const AGENT_NATIVE: ReadonlySet<string> = new Set(["kariaa", "opentask", "near-agent-market"]);

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    return typeof o === "number" && Number.isInteger(o) && o >= 0 && o <= 10_000 ? o : 0;
  } catch {
    throw new ProtocolError("invalid_input", "cursor is not one this server returned.");
  }
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ProtocolError("invalid_input", result.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
}

export { dedupeKey };

/** Score added by catalog tier: platforms where the agent acts first, find-only ones after. */
const TIER_WEIGHT: Record<CatalogTier, number> = { managed: 6, self: 4, discover: -10 };

/**
 * The top `limit` in score order, with no platform taking more than a third of the page while others have
 * results; slots left over go back to the best of the rest. One named platform gets the whole page.
 */
export function spread<T extends { job: { connector: string } }>(ranked: T[], limit: number, single = false): T[] {
  if (single) return ranked.slice(0, limit);
  const cap = Math.max(3, Math.ceil(limit / 3));
  const taken = new Map<string, number>();
  const page: T[] = [];
  const rest: T[] = [];
  for (const item of ranked) {
    const n = taken.get(item.job.connector) ?? 0;
    if (page.length < limit && n < cap) {
      page.push(item);
      taken.set(item.job.connector, n + 1);
    } else rest.push(item);
  }
  // The overflow fills the page only when the other platforms ran out.
  for (const item of rest) {
    if (page.length >= limit) break;
    page.push(item);
  }
  return page;
}

export class WorkProtocol {
  readonly registry: Registry;
  readonly cache: JobCache | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly overrides: CredentialOverrides;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly searchTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly allowLocalFiles: boolean;
  private readonly maxFileBytes: number | undefined;
  private readonly lookup: Lookup | undefined;
  readonly verifiers: Verifier[];
  private candidateProfile: Record<string, string>;
  private readonly store: CredentialStore | undefined;
  private readonly connectUrl: ((connectorId: string) => string | undefined) | undefined;
  private readonly tenant: string | undefined;
  private readonly catalog: "trusted" | "all" | undefined;
  private readonly index: SearchIndex | undefined;
  private readonly payConfirm: PayConfirm;
  /** Shared with every protocol the server builds per request. */
  readonly health: ConnectorHealth | undefined;

  constructor(options: WorkProtocolOptions = {}) {
    this.registry = options.registry ?? new Registry();
    if (options.connectors) this.registry.registerAll(options.connectors);
    this.env = options.env ?? process.env;
    this.overrides = { ...(options.credentials ?? {}) };
    this.store = options.credentialStore;
    this.connectUrl = options.connectUrl;
    this.tenant = options.tenant;
    this.index = options.index;
    this.payConfirm = new PayConfirm(options.confirmSecret);
    this.health = options.health;
    const fromEnv = this.env.WORK_CATALOG?.trim();
    this.catalog = options.catalog ?? (fromEnv === "all" || fromEnv === "trusted" ? fromEnv : undefined);
    for (const [id, values] of Object.entries(this.store?.load?.() ?? {})) {
      const bag = { ...(this.overrides[id] ?? {}) };
      for (const [name, value] of Object.entries(values)) {
        if (bag[name] === undefined && !this.env[name]?.trim()) bag[name] = value;
      }
      this.overrides[id] = bag;
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = options.log ?? (() => {});
    this.searchTimeoutMs = options.searchTimeoutMs ?? envNumber(this.env, "WORK_SEARCH_TIMEOUT_MS") ?? 40_000;
    this.callTimeoutMs = options.callTimeoutMs ?? envNumber(this.env, "WORK_CALL_TIMEOUT_MS") ?? 60_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? envNumber(this.env, "WORK_UPLOAD_TIMEOUT_MS") ?? 600_000;
    this.cache = options.cache === undefined ? new JobCache() : options.cache;
    this.allowLocalFiles = options.allowLocalFiles ?? false;
    this.maxFileBytes = options.maxFileBytes ?? envNumber(this.env, "WORK_MAX_FILE_BYTES");
    this.lookup = options.lookup;
    this.verifiers = options.verifiers ?? [];
    this.candidateProfile = {};
    if (options.candidateProfile) {
      for (const [k, v] of Object.entries(options.candidateProfile)) {
        if (typeof v === "string" && v.trim()) this.candidateProfile[k] = v.trim();
      }
    }
  }

  // ---- connectors -----------------------------------------------------------

  connectors(): ConnectorInfo[] {
    return this.registry.list().map((c) => {
      const credentials = this.credentials(c);
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        ...(c.homepage ? { homepage: c.homepage } : {}),
        kinds: [...c.kinds],
        ...(c.category ? { category: c.category } : {}),
        ...(c.payoutRails ? { payout_rails: [...c.payoutRails] } : {}),
        stages: stagesOf(c),
        ...(this.inCatalog(c) ? {} : { opt_in: true }),
        ...(c.tier ? { tier: c.tier } : {}),
        ...(c.askFirst ? { ask_first: true } : {}),
        ...(this.health?.status(c.id) === "down" ? { health: "down" as const } : {}),
        auth:
          c.auth.type === "none"
            ? { type: "none", configured: true, required: false }
            : c.auth.type === "oauth"
              ? {
                  type: "oauth",
                  configured: isConfigured(c, credentials, this.env),
                  required: c.auth.required === true,
                  ...(c.auth.env ? { env: [c.auth.env] } : {}),
                  help: c.auth.help,
                }
              : {
                  type: "api_key",
                  configured: isConfigured(c, credentials, this.env),
                  required: c.auth.required !== false,
                  env: [...c.auth.env],
                  help: c.auth.help,
                },
        ...(c.profileFields ? { profileFields: [...c.profileFields] } : {}),
      };
    });
  }

  /** Whether a connector joins calls that don't name it: never when opt-in, and only tiered ones in the curated catalog. */
  private inCatalog(c: Connector): boolean {
    if (c.optIn) return false;
    if (c.tier) return true;
    // A registry with no tiered connector (a custom set) behaves as "all".
    const catalog = this.catalog ?? (this.registry.list().some((x) => x.tier) ? "trusted" : "all");
    return catalog === "all";
  }

  private catalogList(): Connector[] {
    return this.registry.list().filter((c) => this.inCatalog(c));
  }

  connector(id: string): Connector {
    const connector = this.registry.get(id);
    if (!connector) {
      throw new ProtocolError(
        "not_found",
        `No connector ${JSON.stringify(id)}. Known: ${
          this.registry
            .list()
            .map((c) => c.id)
            .join(", ") || "none"
        }.`,
      );
    }
    return connector;
  }

  // ---- stages ---------------------------------------------------------------

  async search(input: SearchQuery = {}): Promise<SearchResult> {
    const query = parse(SearchQuerySchema, input);
    const limit = query.limit ?? 20;
    const explicit = Boolean(query.connectors?.length);
    const empty = !query.query?.trim();
    const excluded = new Set(query.exclude_connectors ?? []);
    const targets = (explicit ? query.connectors!.map((id) => this.connector(id)) : this.registry.list()).filter((c) => {
      if (excluded.has(c.id)) return false;
      if (!hasStage(c, "search")) return false;
      if (query.kind && !c.kinds.includes(query.kind)) return false;
      if (query.category && c.category !== query.category) return false;
      if (explicit) return true;
      if (!this.inCatalog(c)) return false;
      if (!canUse(c, this.credentials(c), this.env)) return false;
      if (c.sharedLimitWithoutKey && !this.hasPersonalCredentials(c)) return false;
      if (empty && !c.kinds.includes("task")) return false;
      return true;
    });

    // What the words ask for: filters (pay, payout, remote, kind of work) and the words left to match.
    const understood = understand(query.query);
    const fiatOnly = query.fiat_only === true || understood.fiatOnly === true;
    const remoteOnly = query.remote === true || understood.remoteOnly === true;
    const categories = query.category ? [query.category] : understood.categories;
    const minPayUsd = query.pay_min ?? understood.minPayUsd;
    const postedAfter = query.posted_after?.slice(0, 10) ?? understood.postedAfter;
    const rails = (c: Connector) => c.payoutRails ?? [];
    const payable = (c: Connector) => (!fiatOnly || rails(c).includes("fiat")) && (!understood.cryptoOnly || rails(c).includes("crypto"));
    const offset = decodeCursor(query.cursor);

    // Named platforms answer from the index too when it holds them; get_job re-reads the listing live.
    const covered = this.index ? await this.index.coverage().catch(() => new Set<string>()) : new Set<string>();
    const fromIndex = targets.filter((c) => covered.has(c.id) && payable(c));
    // A platform that keeps failing is left out of catalog searches, but tried again now and then.
    const answering = (c: Connector) => explicit || !this.health || this.health.shouldAsk(c.id);
    let live = offset > 0 ? [] : targets.filter((c) => !covered.has(c.id) && answering(c));

    let hits: IndexHit[] = [];
    if (fromIndex.length && this.index) {
      const embedding = understood.text ? await this.index.embed?.(understood.text) : undefined;
      const ask = (withCategories: boolean) =>
        this.index!.search({
          text: understood.text,
          ...(embedding ? { embedding } : {}),
          connectors: fromIndex.map((c) => c.id),
          ...(query.kind ? { kinds: [query.kind] } : {}),
          ...(withCategories && categories?.length ? { categories } : {}),
          ...(fiatOnly ? { fiatOnly } : {}),
          ...(minPayUsd !== undefined ? { minPayUsd } : {}),
          ...(remoteOnly ? { remoteOnly } : {}),
          ...(postedAfter ? { postedAfter } : {}),
          limit: limit * 2,
          offset,
        });
      try {
        hits = await ask(true);
        // Words like "challenge" only narrow the search; when they leave nothing, drop them.
        if (!hits.length && categories?.length && !query.category) hits = await ask(false);
      } catch (error) {
        this.log("search.index_failed", { message: error instanceof Error ? error.message : String(error) });
        live = targets.filter(answering);
      }
      // A thin answer from the index: also ask its platforms live, for listings beyond the indexed pages.
      if (offset === 0 && understood.text && hits.length < Math.ceil(limit / 2)) live = [...new Set([...live, ...fromIndex])];
    }

    // Sources asked live get the words without the filters ("python", not "python bounty over $200").
    // Ask each live source for more than the page: duplicates, filters and the per-platform cap thin it here.
    const liveQuery: SearchQuery = { ...query, limit: Math.min(50, limit * 2) };
    delete liveQuery.cursor;
    delete liveQuery.exclude_connectors;
    if (query.query) {
      if (understood.core) liveQuery.query = understood.core;
      else delete liveQuery.query;
    }
    const { buckets, partial } = await this.searchLive(live, liveQuery);

    const seen = new Set<string>();
    const candidates: { job: Job; hit?: IndexHit }[] = [];
    for (const hit of hits) {
      const key = dedupeKey(hit.job);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ job: hit.job, hit });
    }
    const longest = Math.max(0, ...buckets.map((b) => b.jobs.length));
    for (let i = 0; i < longest; i += 1) {
      for (const bucket of buckets) {
        const job = bucket.jobs[i];
        if (!job) continue;
        const key = dedupeKey(job);
        const repeat = repeatKey(job);
        if (seen.has(key) || seen.has(repeat)) continue;
        seen.add(key);
        seen.add(repeat);
        candidates.push({ job });
      }
    }

    const usd = (job: Job) => payUsd(job, FALLBACK_USD_RATES);
    const coreWords = understood.core
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/u)
      .filter((w) => w.length > 1);
    let filtered = candidates.filter(({ job, hit }) => {
      const source = this.registry.get(job.connector);
      // Some sources ignore the words, and the index matches any one of them: every result has to be about them.
      // A strong meaning match from the index stands on its own.
      if (coreWords.length && !mentions(job, coreWords, hit?.textHit === true) && !((hit?.similarity ?? 0) >= 0.45)) return false;
      if (hit) return true; // the index applied the other filters already
      if (minPayUsd !== undefined && (usd(job) ?? 0) < minPayUsd) return false;
      if (source && !payable(source)) return false;
      if (remoteOnly && job.location?.remote === false) return false;
      return true;
    });
    if (query.currency && query.currency.trim().length > 0) {
      const wantedCurrency = query.currency.trim().toUpperCase();
      filtered = filtered.filter(({ job }) => job.pay?.currency?.toUpperCase() === wantedCurrency);
    }
    if (postedAfter) {
      const today = new Date().toISOString().slice(0, 10);
      filtered = filtered.filter(({ job }) =>
        // Undated work counts while a dated round is running (a bounty or competition with a closing date);
        // standing programs with no dates at all aren't new.
        job.posted_at ? job.posted_at.slice(0, 10) >= postedAfter : Boolean(job.expires_at) && job.expires_at!.slice(0, 10) >= today,
      );
    }
    if (query.direct_apply === true) {
      filtered = filtered.filter(({ job }) => job.participation_mode === "direct_apply" || job.stages.includes("apply"));
    }

    const scoring: SearchQuery = { ...query, ...(understood.core ? { query: understood.core } : {}) };
    const score = ({ job, hit }: { job: Job; hit?: IndexHit }): number => {
      const source = this.registry.get(job.connector);
      let s = scoreJob(job, scoring, source?.payoutRails);
      // No flat bonus for coming from the index: an indexed platform must not outrank a live one by being indexed.
      if (hit) s += (hit.textHit ? 6 : 0) + Math.max(0, hit.similarity ?? 0) * 40;
      if (understood.forAgents && AGENT_NATIVE.has(job.connector)) s += 20;
      // The query named a kind of work (bounty, competition…): that kind first, the others well behind.
      if (source?.category && understood.categories?.length) s += understood.categories.includes(source.category) ? 12 : -20;
      if (source && this.hasPersonalCredentials(source)) s += 8;
      // Where the agent can do the work itself first; find-only platforms (the person applies) after.
      if (source?.tier) s += TIER_WEIGHT[source.tier];
      const pay = hit?.pay_usd ?? usd(job);
      if (pay) s += Math.min(15, Math.log10(pay + 1) * 5);
      return s;
    };
    filtered.sort((a, b) => score(b) - score(a));
    const truncated = filtered.length > limit;
    const jobs = spread(filtered, limit, explicit && query.connectors!.length === 1).map((c) => c.job);

    if (this.cache) {
      this.cache.setMany([...hits.map((h) => h.job), ...buckets.flatMap((b) => b.jobs)]);
      this.cache.save();
    }
    const nextCursor = hits.length >= limit * 2 ? encodeCursor(offset + limit * 2) : undefined;
    return {
      jobs,
      more: truncated || buckets.some((b) => b.more) || nextCursor !== undefined,
      partial,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    };
  }

  /** Asks each connector live, in parallel, each within the search budget. */
  private async searchLive(
    targets: Connector[],
    query: SearchQuery,
  ): Promise<{ buckets: { jobs: Job[]; more: boolean }[]; partial: PartialFailure[] }> {
    const settled = await Promise.allSettled(
      targets.map((c) =>
        this.call(c, this.searchTimeoutMs, async (ctx) => {
          const out = await c.search!(query, ctx);
          return { jobs: out.jobs.map((job) => this.publishJob(c, job)), more: out.more === true };
        }),
      ),
    );
    const partial: PartialFailure[] = [];
    const buckets: { jobs: Job[]; more: boolean }[] = [];
    settled.forEach((result, index) => {
      const connector = targets[index]!;
      if (result.status === "fulfilled") {
        this.health?.ok(connector.id);
        buckets.push(result.value);
        return;
      }
      const error = toProtocolError(result.reason, connector.id);
      this.health?.failed(connector.id, error.code);
      this.log("search.failed", { connector: connector.id, code: error.code, message: error.message });
      partial.push({ connector: connector.id, error: { code: error.code, message: error.message } });
    });
    return { buckets, partial };
  }

  async get(id: string): Promise<Job> {
    const { connector: connectorId, native } = parseId(id);
    const connector = this.connector(connectorId);
    if (hasStage(connector, "get")) {
      let found: NativeJob | null;
      try {
        found = await this.call(connector, this.callTimeoutMs, (ctx) => connector.get!(native, ctx));
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "not_found") this.forget(id);
        throw error;
      }
      if (found) {
        const job = this.publishJob(connector, found);
        this.cache?.set(job);
        this.cache?.save();
        return job;
      }
      this.forget(id);
      throw new ProtocolError("not_found", `No job ${id}.`, { connector: connectorId });
    }
    const cached = this.cache?.get(id);
    if (cached) return cached;
    throw new ProtocolError(
      "not_found",
      `${connector.name} cannot look a job up by id, and ${id} is not in the recent search cache. Run search_jobs again, then get_job.`,
      { connector: connectorId },
    );
  }

  /**
   * The job id of the posting at a web address, when a connector here reads that site; null when none does.
   * Reads only. `connectors` narrows the connectors asked.
   */
  async resolve(address: string, options: { connectors?: readonly string[] } = {}): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(address.trim());
    } catch {
      throw new ProtocolError("invalid_input", "url is not a web address.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ProtocolError("invalid_input", "url must start with https://.");
    for (const connector of this.registry.list()) {
      if (typeof connector.resolveUrl !== "function") continue;
      if (options.connectors && !options.connectors.includes(connector.id)) continue;
      let native: string | null;
      try {
        native = await this.call(connector, this.callTimeoutMs, (ctx) => connector.resolveUrl!(url, ctx));
      } catch (error) {
        // The site has no such company or posting: not this connector's.
        if (error instanceof ProtocolError && error.code === "not_found") continue;
        throw error;
      }
      if (native) return makeId(connector.id, native);
    }
    return null;
  }

  async apply(jobId: string, input: ApplyInput = {}): Promise<Application> {
    const applyInput = parse(ApplyInputSchema, input);
    const { connector: connectorId, native } = parseId(jobId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "apply", jobId);
    await this.ensureCandidateProfile(connectorId);
    const enrichedInput = this.enrichApplyInput(connectorId, jobId, applyInput);
    const application = await this.call(connector, this.callTimeoutMs, (ctx) => connector.apply!(native, enrichedInput, ctx));
    return this.publishApplication(connector, application);
  }

  async upload(applicationId: string, work: WorkInput): Promise<WorkReceipt & { application_id: string }> {
    const { connector: connectorId, native } = parseId(applicationId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "upload");
    const resolved = await resolveWork(work, {
      allowLocalFiles: this.allowLocalFiles,
      maxBytes: this.maxFileBytes,
      fetch: this.fetchImpl,
      lookup: this.lookup,
    });
    const receipt = await this.call(connector, this.uploadTimeoutMs, (ctx) => connector.upload!(native, resolved, ctx));
    return { application_id: applicationId, ...receipt };
  }

  async remove(applicationId: string, fileId: string): Promise<WorkReceipt & { application_id: string }> {
    const { connector: connectorId, native } = parseId(applicationId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "remove");
    const receipt = await this.call(connector, this.callTimeoutMs, (ctx) => connector.remove!(native, fileId, ctx));
    return { application_id: applicationId, ...receipt };
  }

  async submit(applicationId: string, input: { note?: string } = {}): Promise<Application> {
    const { connector: connectorId, native } = parseId(applicationId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "submit");
    const application = await this.call(connector, this.callTimeoutMs, (ctx) => connector.submit!(native, input, ctx));
    return this.publishApplication(connector, application);
  }

  async status(applicationId: string): Promise<Application> {
    const { connector: connectorId, native } = parseId(applicationId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "status");
    const application = await this.call(connector, this.callTimeoutMs, (ctx) => connector.status!(native, ctx));
    if (!application) throw new ProtocolError("not_found", `No application ${applicationId}.`, { connector: connectorId });
    return this.publishApplication(connector, application);
  }

  private hasPersonalCredentials(connector: Connector): boolean {
    if (connector.auth.type === "none") return true;
    const creds = this.credentials(connector);
    if (connector.auth.type === "api_key") {
      return connector.auth.env.some((name) => Boolean(creds[name]?.trim()));
    }
    return isConfigured(connector, creds, this.env);
  }

  async list(connectorId?: string): Promise<{ applications: Application[]; partial: PartialFailure[] }> {
    const targets = connectorId
      ? [this.connector(connectorId)]
      : this.catalogList().filter((c) => hasStage(c, "list") && this.hasPersonalCredentials(c));
    if (connectorId) this.requireStage(targets[0]!, "list");
    const settled = await Promise.allSettled(
      targets.map((c) => this.call(c, this.callTimeoutMs, async (ctx) => (await c.list!(ctx)).map((a) => this.publishApplication(c, a)))),
    );
    const applications: Application[] = [];
    const partial: PartialFailure[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") applications.push(...result.value);
      else {
        const error = toProtocolError(result.reason, targets[index]!.id);
        partial.push({ connector: targets[index]!.id, error: { code: error.code, message: error.message } });
      }
    });
    return { applications, partial };
  }

  async link(applicationId: string): Promise<Link> {
    const { connector: connectorId, native } = parseId(applicationId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "link");
    return this.call(connector, this.callTimeoutMs, (ctx) => connector.link!(native, ctx));
  }

  async accounts(connectorId?: string): Promise<Array<Account & { connector: string }>> {
    const targets = connectorId
      ? [this.connector(connectorId)]
      : this.catalogList().filter((c) => hasStage(c, "account") && this.hasPersonalCredentials(c));
    if (connectorId) this.requireStage(targets[0]!, "account");
    const settled = await Promise.allSettled(targets.map((c) => this.call(c, this.callTimeoutMs, (ctx) => c.account!(ctx))));
    return settled.map((result, index) => {
      const connector = targets[index]!;
      if (result.status === "fulfilled") return { connector: connector.id, ...result.value };
      const error = toProtocolError(result.reason, connector.id);
      return { connector: connector.id, signed_in: false, help: `${error.code}: ${error.message}` };
    });
  }

  /**
   * Gets the agent onto a platform. Connected already: the account. A platform with a sign-up
   * API and `input.email`: registers, keeps the key and answers connected. Otherwise the steps.
   */
  async connect(connectorId: string, input: Partial<RegisterInput> = {}): Promise<Connection> {
    const connector = this.connector(connectorId);
    const connected = (account?: Account): Connection => ({
      connector: connector.id,
      name: connector.name,
      status: "connected",
      method: typeof connector.register === "function" ? "register" : connector.auth.type,
      ...(account ? { account } : {}),
    });
    if (connector.auth.type === "none") return connected();
    let rejected: string | undefined;
    if (isConfigured(connector, this.credentials(connector), this.env)) {
      const checked = await this.check(connector);
      if (checked.ok) return connected(checked.account);
      rejected = checked.reason;
    }
    const email = input.email?.trim();
    if (typeof connector.register === "function" && email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new ProtocolError("invalid_input", "email must be an email address.");
      const registration = await this.call(connector, this.callTimeoutMs, (ctx) =>
        connector.register!({ ...input, email } as RegisterInput, ctx),
      );
      const saved = await this.saveCredentials(connector.id, registration.credentials);
      return {
        ...saved,
        registered: {
          ...(registration.account_id ? { account_id: registration.account_id } : {}),
          ...(registration.next_step ? { next_step: registration.next_step } : {}),
        },
      };
    }
    return connectPlan(connector, {
      hosted: this.env.WORK_HOSTED === "1",
      ...(this.connectUrl ? { connectUrl: this.connectUrl } : {}),
      ...(rejected ? { rejected } : {}),
    });
  }

  /** Every connector that needs an account, connected or with its next step. Nothing is registered. */
  async connections(): Promise<Connection[]> {
    const targets = this.catalogList().filter((c) => c.auth.type !== "none");
    return Promise.all(
      targets.map(async (c) => {
        try {
          return await this.connect(c.id);
        } catch (error) {
          const err = toProtocolError(error, c.id);
          return connectPlan(c, { hosted: this.env.WORK_HOSTED === "1", rejected: `${err.code}: ${err.message}` });
        }
      }),
    );
  }

  /** Checks credentials against the platform, then keeps them. A credential it refuses is not kept. */
  async saveCredentials(connectorId: string, values: Record<string, unknown>): Promise<Connection> {
    const connector = this.connector(connectorId);
    const names = saveableNames(connector);
    if (names.length === 0) throw new ProtocolError("invalid_input", `${connector.name} needs no credentials.`);
    const clean: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (!names.includes(name)) {
        throw new ProtocolError("invalid_input", `${connector.name} takes ${names.join(", ")}, not ${name}.`, { connector: connector.id });
      }
      if (typeof value !== "string" || !value.trim()) throw new ProtocolError("invalid_input", `${name} is empty.`);
      clean[name] = value.trim();
    }
    if (Object.keys(clean).length === 0) {
      throw new ProtocolError("invalid_input", `Give ${names.join(", ")}.`, { connector: connector.id });
    }
    const before = this.overrides[connector.id];
    this.overrides[connector.id] = { ...(before ?? {}), ...clean };
    const restore = () => {
      if (before) this.overrides[connector.id] = before;
      else delete this.overrides[connector.id];
    };
    const checked = await this.check(connector);
    if (!checked.ok && checked.refused) {
      restore();
      throw new ProtocolError("auth_required", `${connector.name} did not accept that: ${checked.reason}`, { connector: connector.id });
    }
    try {
      await this.store?.save(connector.id, clean);
    } catch (error) {
      restore();
      throw error;
    }
    return {
      connector: connector.id,
      name: connector.name,
      status: "connected",
      method: typeof connector.register === "function" ? "register" : connector.auth.type,
      ...(checked.ok && checked.account ? { account: checked.account } : {}),
      ...(checked.ok ? {} : { steps: [`Kept, but not checked: ${checked.reason}`] }),
      stored: this.store?.where ?? "this session only",
    };
  }

  /** Asks the platform who the credentials belong to. `refused`: the platform said no, not a timeout. */
  private async check(connector: Connector): Promise<{ ok: true; account?: Account } | { ok: false; refused: boolean; reason: string }> {
    if (typeof connector.account !== "function") return { ok: true };
    try {
      const account = await this.call(connector, this.callTimeoutMs, (ctx) => connector.account!(ctx));
      if (account.signed_in === false) return { ok: false, refused: true, reason: account.help ?? "not signed in" };
      return { ok: true, account };
    } catch (error) {
      const err = toProtocolError(error, connector.id);
      return { ok: false, refused: err.code === "auth_required", reason: err.message };
    }
  }

  async updateAccount(connectorId: string, fields: Record<string, unknown>): Promise<Account> {
    const connector = this.connector(connectorId);
    if (typeof connector.updateAccount !== "function") {
      throw new ProtocolError("not_supported", `${connector.name} has no profile to update.`, { connector: connectorId });
    }
    const allowed = connector.profileFields?.map((f) => f.name);
    if (allowed) {
      const unknown = Object.keys(fields).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) {
        throw new ProtocolError(
          "invalid_input",
          `Unknown field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. ${connector.name} accepts: ${allowed.join(", ")}.`,
          {
            connector: connectorId,
            details: { unknown, allowed },
          },
        );
      }
    }
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "string" && v.trim()) {
        this.candidateProfile[k] = v.trim();
      }
    }
    const updated = await this.call(connector, this.callTimeoutMs, (ctx) => connector.updateAccount!(fields, ctx));
    if (updated.profile) {
      for (const [k, v] of Object.entries(updated.profile)) {
        if (typeof v === "string" && v.trim()) {
          this.candidateProfile[k] = v.trim();
        }
      }
    }
    return updated;
  }

  /** Runs the verifiers over work before it is sent: pass, fail or uncertain, each check, and the pay for the accepted pieces. */
  async verify(
    jobId: string,
    work: WorkInput[] = [],
    answers?: Record<string, string | string[]>,
  ): Promise<Verification & { job_id: string }> {
    const hasWork = Array.isArray(work) && work.length > 0;
    const hasAnswers = Boolean(answers && Object.keys(answers).length > 0);
    if (!hasWork && !hasAnswers) throw new ProtocolError("invalid_input", "Give at least one piece of work to verify.");
    const job = await this.get(jobId);
    const resolved = [];
    for (const piece of work) {
      resolved.push(
        await resolveWork(piece, {
          allowLocalFiles: this.allowLocalFiles,
          maxBytes: this.maxFileBytes,
          fetch: this.fetchImpl,
          lookup: this.lookup,
        }),
      );
    }
    const verification = await verifyWork(
      { job, work: resolved, ...(answers ? { answers } : {}) },
      { verifiers: this.verifiers, ctx: { log: this.log } },
    );
    return { job_id: job.id, ...verification };
  }

  async earnings(connectorId?: string): Promise<{ earnings: Earnings[]; partial: PartialFailure[] }> {
    const targets = connectorId
      ? [this.connector(connectorId)]
      : this.catalogList().filter((c) => hasStage(c, "earnings") && this.hasPersonalCredentials(c));
    if (connectorId) this.requireStage(targets[0]!, "earnings");
    const settled = await Promise.allSettled(targets.map((c) => this.call(c, this.callTimeoutMs, (ctx) => c.earnings!(ctx))));
    const earnings: Earnings[] = [];
    const partial: PartialFailure[] = [];
    settled.forEach((result, index) => {
      const connector = targets[index]!;
      if (result.status === "fulfilled") earnings.push(this.publishEarnings(connector, result.value));
      else {
        const error = toProtocolError(result.reason, connector.id);
        partial.push({ connector: connector.id, error: { code: error.code, message: error.message } });
      }
    });
    return { earnings, partial };
  }

  async requestPayout(connectorId: string, input: PayoutInput): Promise<Payout> {
    const payoutInput = parse(PayoutInputSchema, input);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "payout");
    const payout = await this.call(connector, this.callTimeoutMs, (ctx) => connector.payout!(payoutInput, ctx));
    return this.publishPayout(connector, payout);
  }

  // ---- giving work out ------------------------------------------------------

  /** Post a job on one platform. Nothing is paid here: `pay` sets money aside, after a confirm step. */
  async post(connectorId: string, input: PostInput): Promise<Posting> {
    const postInput = parse(PostInputSchema, input);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "post");
    const posting = await this.call(connector, this.callTimeoutMs, (ctx) => connector.post!(postInput, ctx));
    return this.publishPosting(connector, posting);
  }

  /** The jobs you posted, on one platform or on every platform that has any. */
  async postings(connectorId?: string): Promise<{ postings: Posting[]; partial: PartialFailure[] }> {
    const targets = connectorId
      ? [this.connector(connectorId)]
      : this.registry.list().filter((c) => hasStage(c, "postings") && this.hasPersonalCredentials(c));
    if (connectorId) this.requireStage(targets[0]!, "postings");
    const settled = await Promise.allSettled(
      targets.map((c) => this.call(c, this.callTimeoutMs, async (ctx) => (await c.postings!(ctx)).map((p) => this.publishPosting(c, p)))),
    );
    const postings: Posting[] = [];
    const partial: PartialFailure[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") postings.push(...result.value);
      else {
        const error = toProtocolError(result.reason, targets[index]!.id);
        partial.push({ connector: targets[index]!.id, error: { code: error.code, message: error.message } });
      }
    });
    return { postings, partial };
  }

  /** One posting with the bids, applications or entries on it. */
  async offers(postingId: string): Promise<{ posting: Posting; offers: Offer[] }> {
    const { connector: connectorId, native } = parseId(postingId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "offers");
    const found = await this.call(connector, this.callTimeoutMs, (ctx) => connector.offers!(native, ctx));
    if (!found) throw new ProtocolError("not_found", `No posting ${postingId} of yours.`, { connector: connectorId });
    return {
      posting: this.publishPosting(connector, found.posting),
      offers: found.offers.map((offer) => this.checkOffer(connector, offer)),
    };
  }

  /** Pick an offer. */
  async award(postingId: string, offerId: string): Promise<Posting> {
    const { connector: connectorId, native } = parseId(postingId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "award");
    if (!offerId?.trim()) throw new ProtocolError("invalid_input", "Say which offer: its id from the offers list.");
    const posting = await this.call(connector, this.callTimeoutMs, (ctx) => connector.award!(native, offerId, ctx));
    return this.publishPosting(connector, posting);
  }

  /** Judge delivered work. Accepting does not pay: `pay` does. */
  async review(postingId: string, input: ReviewInput): Promise<Posting> {
    const reviewInput = parse(ReviewInputSchema, input);
    if (reviewInput.decision !== "accept" && !reviewInput.note?.trim())
      throw new ProtocolError("invalid_input", "Say what to change, or why it is rejected, in note.");
    const { connector: connectorId, native } = parseId(postingId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "review");
    const posting = await this.call(connector, this.callTimeoutMs, (ctx) => connector.review!(native, reviewInput, ctx));
    return this.publishPosting(connector, posting);
  }

  /**
   * Set money aside for a posting, or hand it over. Two calls, always: the first moves nothing and
   * answers `confirm_needed` with what would happen and a token; the second, with that token, does it.
   * The token is tied to the posting, the offer, the action and the amount, so changing any of them
   * needs a new confirmation.
   */
  async pay(postingId: string, input: PayInput = {}): Promise<Payment> {
    const payInput = parse(PayInputSchema, input);
    const { connector: connectorId, native } = parseId(postingId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "pay");
    const { confirm, ...asked } = payInput;
    const terms = {
      ...asked,
      ...(asked.amount ? { amount: { amount: asked.amount.amount, currency: asked.amount.currency.toUpperCase() } } : {}),
    };
    // What the platform says would happen. Without a quote, the caller's own terms are all there is to confirm.
    const quote: NativePayment =
      typeof connector.quote === "function"
        ? await this.call(connector, this.callTimeoutMs, (ctx) => connector.quote!(native, terms, ctx))
        : { status: "confirm_needed", ...(terms.action ? { action: terms.action } : {}) };
    if (quote.status !== "confirm_needed")
      throw new ProtocolError("upstream_error", quote.next ?? `${connector.name} cannot take this payment now (${quote.status}).`, {
        connector: connectorId,
      });
    const quoted = quote.amount ? { amount: quote.amount.amount, currency: quote.amount.currency.toUpperCase() } : undefined;
    if (terms.amount && quoted && (terms.amount.amount !== quoted.amount || terms.amount.currency !== quoted.currency))
      throw new ProtocolError(
        "invalid_input",
        `${connector.name} says ${quoted.amount} ${quoted.currency} is what this payment is. Leave amount out, or ask with that amount.`,
        { connector: connectorId, details: { amount: quoted } },
      );
    const amount = quoted ?? terms.amount;
    if (!amount)
      throw new ProtocolError(
        "invalid_input",
        `Say the amount: ${connector.name} does not report what is owed, and a payment is never confirmed blind.`,
        {
          connector: connectorId,
        },
      );
    const settled = { ...terms, amount, ...(quote.action ? { action: quote.action } : {}) };
    const bound = {
      posting: postingId,
      ...(settled.offer ? { offer: settled.offer } : {}),
      ...(settled.action ? { action: settled.action } : {}),
      amount,
      ...(quote.to ? { to: quote.to } : {}),
      ...(quote.fee ? { fee: quote.fee } : {}),
    };
    const state = this.payConfirm.check(confirm, bound);
    if (state !== "ok") {
      const what = `${settled.action === "release" ? "Release" : settled.action === "fund" ? "Set aside" : "Pay"} ${amount.amount} ${amount.currency}${
        quote.to ? ` to ${quote.to}` : ""
      }${quote.fee ? ` (fee ${quote.fee.amount} ${quote.fee.currency})` : ""} on ${connector.name}`;
      const why =
        state === "expired"
          ? "That confirm token has run out. "
          : state === "mismatch"
            ? "That confirm token is not for these terms. "
            : "";
      return this.publishPayment(connector, postingId, {
        ...quote,
        amount,
        status: "confirm_needed",
        confirm: this.payConfirm.issue(bound),
        next: `${why}${what}. Nothing has moved. Call pay again within 15 minutes with confirm set to this token to go ahead.`,
      });
    }
    const paid = await this.call(connector, this.callTimeoutMs, (ctx) => connector.pay!(native, settled, ctx));
    if (paid.status === "confirm_needed")
      throw new ProtocolError("upstream_error", `${connector.name} did not carry out the payment.`, { connector: connectorId });
    try {
      return this.publishPayment(connector, postingId, paid);
    } catch {
      // The money step has run. An answer this version cannot read must not look like a failed call that is safe to repeat.
      return {
        connector: connector.id,
        posting_id: postingId,
        status: "pending",
        ...(settled.action ? { action: settled.action } : {}),
        amount,
        next: `${connector.name} took the payment call but its answer could not be read. Do not pay again: check the posting first.`,
      };
    }
  }

  /** Close a posting. */
  async cancelPosting(postingId: string, input: { note?: string } = {}): Promise<Posting> {
    const { connector: connectorId, native } = parseId(postingId);
    const connector = this.connector(connectorId);
    this.requireStage(connector, "cancel");
    const posting = await this.call(connector, this.callTimeoutMs, (ctx) => connector.cancel!(native, input, ctx));
    return this.publishPosting(connector, posting);
  }

  private publishPosting(connector: Connector, posting: NativePosting): Posting {
    return parse(PostingSchema, { ...posting, id: makeId(connector.id, posting.id), connector: connector.id });
  }

  private publishPayment(connector: Connector, postingId: string, payment: NativePayment): Payment {
    return parse(PaymentSchema, { ...payment, connector: connector.id, posting_id: postingId });
  }

  private checkOffer(connector: Connector, offer: Offer): Offer {
    const parsed = OfferSchema.safeParse(offer);
    if (!parsed.success)
      throw new ProtocolError("upstream_error", `${connector.name} returned an offer this version cannot read.`, {
        connector: connector.id,
      });
    return parsed.data;
  }

  /** Persists the cache and releases connector connections. */
  async close(): Promise<void> {
    this.cache?.save();
    for (const connector of this.registry.list()) {
      if (typeof connector.close !== "function") continue;
      try {
        await connector.close();
      } catch (error) {
        this.log("connector.close_failed", { connector: connector.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // ---- internals ------------------------------------------------------------

  setCandidateProfile(profile: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(profile)) {
      if (typeof v === "string" && v.trim()) this.candidateProfile[k] = v.trim();
    }
  }

  private async ensureCandidateProfile(connectorId: string): Promise<void> {
    if (!ATS_CONNECTORS.has(connectorId)) return;
    const hasEmail = Boolean(this.candidateProfile.email);
    const hasName = Boolean(
      this.candidateProfile.name ||
      this.candidateProfile.full_name ||
      this.candidateProfile.first_name ||
      this.candidateProfile.legal_first_name,
    );
    if (hasEmail && hasName) return;

    const kariaaConn = this.registry.get("kariaa");
    if (!kariaaConn || !hasStage(kariaaConn, "account")) return;
    const creds = this.credentials(kariaaConn);
    if (!creds.KARIAA_API_KEY) return;
    try {
      const account = await this.call(kariaaConn, 10_000, (ctx) => kariaaConn.account!(ctx));
      if (account.profile) {
        for (const [k, v] of Object.entries(account.profile)) {
          if (typeof v === "string" && v.trim() && !this.candidateProfile[k]) {
            this.candidateProfile[k] = v.trim();
          }
        }
      }
    } catch {
      // Best-effort profile hydration
    }
  }

  private enrichApplyInput(connectorId: string, jobId: string, input: ApplyInput): ApplyInput {
    const profile = this.candidateProfile;
    if (Object.keys(profile).length === 0) return input;

    const fullName =
      profile.name ||
      profile.full_name ||
      [profile.first_name || profile.legal_first_name, profile.last_name || profile.legal_last_name].filter(Boolean).join(" ").trim();
    const firstName = profile.first_name || profile.legal_first_name || (fullName ? fullName.split(/\s+/u)[0] : undefined);
    const lastName =
      profile.last_name || profile.legal_last_name || (fullName ? fullName.split(/\s+/u).slice(1).join(" ") || firstName : undefined);
    const email = profile.email;
    const phone = profile.phone || profile.phone_number;
    const linkedin = profile.linkedin_url || profile.linkedin;
    const github = profile.github_url || profile.github;
    const portfolio = profile.portfolio_url || profile.website || profile.portfolio;
    const location = profile.location;
    const resumeUrl = profile.resume_url || profile.cv_url;

    const defaults: Record<string, string | undefined> = {
      name: fullName || undefined,
      full_name: fullName || undefined,
      _systemfield_name: fullName || undefined,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
      email,
      _systemfield_email: email,
      phone,
      phone_number: phone,
      _systemfield_phone: phone,
      linkedin,
      linkedin_url: linkedin,
      "urls.LinkedIn": linkedin,
      github,
      github_url: github,
      "urls.GitHub": github,
      portfolio,
      portfolio_url: portfolio,
      website: portfolio,
      "urls.Portfolio": portfolio,
      location,
      resume: resumeUrl,
      resume_url: resumeUrl,
      cv_url: resumeUrl,
      _systemfield_resume: resumeUrl,
    };

    const isAts = ATS_CONNECTORS.has(connectorId);
    const cachedJob = this.cache?.get(jobId);
    const questionIds = new Set((cachedJob?.requirements?.questions ?? []).map((q) => q.id));

    if (!isAts && questionIds.size === 0) return input;

    const mergedAnswers: Record<string, string | string[]> = { ...(input.answers ?? {}) };
    for (const [key, val] of Object.entries(defaults)) {
      if (!val) continue;
      if (isAts || questionIds.has(key)) {
        const existing = mergedAnswers[key];
        const isEmpty = existing === undefined || (typeof existing === "string" && !existing.trim());
        if (isEmpty) {
          mergedAnswers[key] = val;
        }
      }
    }

    return {
      ...input,
      answers: mergedAnswers,
      ...(input.note === undefined && profile.bio && isAts ? { note: profile.bio } : {}),
    };
  }

  private credentials(connector: Connector): Record<string, string | undefined> {
    return credentialsFor(connector, this.env, this.overrides[connector.id]);
  }

  private context(connector: Connector, signal: AbortSignal): ConnectorContext {
    return { credentials: this.credentials(connector), fetch: this.fetchImpl, signal, log: this.log };
  }

  private async call<T>(connector: Connector, timeoutMs: number, fn: (ctx: ConnectorContext) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new ProtocolError("timeout", `${connector.name} did not answer within ${Math.round(timeoutMs / 1000)} s.`, {
            connector: connector.id,
          }),
        ),
      timeoutMs,
    );
    try {
      return await runAsTenant(this.tenant, () => fn(this.context(connector, controller.signal)));
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof ProtocolError) throw controller.signal.reason;
      throw this.linkHint(toProtocolError(error, connector.id), connector);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Where a connect page exists (hosted), a platform with no key for this person says where to link it,
   * instead of the connector's own help about environment variables. A refused key keeps its message.
   */
  private linkHint(error: ProtocolError, connector: Connector): ProtocolError {
    const url = this.connectUrl?.(connector.id);
    if (error.code !== "auth_required" || !url || this.hasPersonalCredentials(connector)) return error;
    return new ProtocolError("auth_required", `${connector.name} isn't linked for this account yet. The person links it at ${url}.`, {
      connector: connector.id,
      details: { ...error.details, connect_url: url },
    });
  }

  /** The platform says the listing is gone: search stops offering it now rather than at the next index refresh. */
  private forget(id: string): void {
    void this.index?.forget?.(id).catch((error: unknown) => {
      this.log("index.forget_failed", { id, message: error instanceof Error ? error.message : String(error) });
    });
  }

  private requireStage(connector: Connector, stage: Stage, jobId?: string): void {
    if (connector.tier === "discover" && ACTION_STAGES.has(stage)) throw this.handoff(connector, stage, jobId);
    if (hasStage(connector, stage)) return;
    const cached = jobId ? this.cache?.get(jobId) : undefined;
    const hint = cached?.apply_hint ?? (cached?.url ? `Apply at ${cached.url}` : undefined);
    throw new ProtocolError("not_supported", `${connector.name} does not support ${stage}.${hint ? ` ${hint}` : ""}`, {
      connector: connector.id,
      details: { stage, ...(hint ? { apply_hint: hint } : {}), ...(cached?.url ? { url: cached.url } : {}) },
    });
  }

  /** What the person does on the platform's own site, for a step the agent may not take there. */
  private handoff(connector: Connector, stage: Stage, id?: string): ProtocolError {
    const cached = id ? this.cache?.get(id) : undefined;
    const url = cached?.url ?? connector.homepage;
    const steps = [
      ...(url ? [`Open ${url} signed in to your own ${connector.name} account.`] : [`Sign in to your own ${connector.name} account.`]),
      ...(stage === "payout"
        ? ["Request the payout there; my_earnings keeps showing the balance if your account is linked."]
        : [
            "Paste the work the agent prepared (the files and the note) into the platform's own form, and submit it yourself.",
            "Linking your account keeps my_applications and my_earnings up to date.",
          ]),
    ];
    return new ProtocolError(
      "handoff_required",
      `${connector.name} doesn't let agents ${stage === "payout" ? "request payouts" : "act"} for you, so this step is yours. ${steps.join(" ")}`,
      {
        connector: connector.id,
        details: {
          stage,
          handoff: { ...(url ? { url } : {}), ...(cached?.title ? { title: cached.title } : {}), steps },
        },
      },
    );
  }

  private publishJob(connector: Connector, job: NativeJob): Job {
    const offered = job.stages ?? stagesOf(connector).filter((s) => !SKIP_FOR_JOBS.has(s));
    // On a discover-tier platform the person takes every action on the site.
    const stages = connector.tier === "discover" ? offered.filter((s) => !ACTION_STAGES.has(s)) : offered;
    const handsOff = connector.tier === "discover" || (job.kind === "listing" && !hasStage(connector, "apply"));
    const hint = job.apply_hint ?? (handsOff && job.url ? `Apply at ${job.url}` : undefined);
    return {
      ...job,
      id: makeId(connector.id, job.id),
      connector: connector.id,
      stages,
      ...(hint ? { apply_hint: hint } : {}),
    };
  }

  private publishApplication(connector: Connector, application: NativeApplication): Application {
    return {
      ...application,
      id: makeId(connector.id, application.id),
      job_id: makeId(connector.id, application.job_id),
      connector: connector.id,
    };
  }

  private publishPayout(connector: Connector, payout: NativePayout): Payout {
    return { ...payout, id: makeId(connector.id, payout.id), connector: connector.id };
  }

  private publishEarnings(connector: Connector, earnings: NativeEarnings): Earnings {
    const { entries, payouts, ...rest } = earnings;
    const published: Earnings = { ...rest, connector: connector.id };
    if (entries) {
      published.entries = entries.map((e) => ({
        ...e,
        ...(e.application_id ? { application_id: makeId(connector.id, e.application_id) } : {}),
      }));
    }
    if (payouts) published.payouts = payouts.map((p) => this.publishPayout(connector, p));
    return published;
  }
}
