/**
 * Algora bounties: open GitHub issues that Algora's bot (`algora-pbc[bot]`) has priced, in a curated set of
 * organisations, paid in fiat through Stripe Connect on algora.io once the maintainers award the fix.
 *
 * Algora no longer serves a public JSON API (console.algora.io/api/orgs/{org}/bounties redirects to a 404, and
 * the tRPC `bounty.list` answers an empty list for every input), so discovery reads GitHub: the issue search
 * finds open issues the bot commented on, and the bot's `## 💎 $X bounty [• Sponsor](…)` comment is the
 * proof and the price. A `💎 Bounty` label alone proves nothing: anyone can create it, and label farms do.
 *
 * Claiming is a `/attempt #N` comment on the issue and a `/claim #N` on the pull request, both posted as the
 * person with their GITHUB_TOKEN, each only after a confirmation token.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConnector, type ConnectorContext } from "../../core/connector.js";
import { ProtocolError, toProtocolError } from "../../core/errors.js";
import { applyFilters, iso, num, str } from "../../core/jsonBoard.js";
import { stripHtml, truncate } from "../../core/text.js";
import type { NativeApplication, NativeJob, Pay } from "../../core/types.js";
import { USER_AGENT } from "../../core/version.js";
import { perTenant, stateDir } from "../../core/tenant.js";

export const GITHUB_API = "https://api.github.com";
export const ALGORA_BOT = "algora-pbc[bot]";
const ID = "algora";
const TOKEN_ENV = "GITHUB_TOKEN";

/**
 * Organisations with open issues carrying an algora-pbc[bot] bounty comment, checked on 2026-10-27. Each one
 * had at least one open, unrewarded bounty posted in 2023 or later. ALGORA_ORGS replaces the list.
 */
export const DEFAULT_ALGORA_ORGS = [
  "tscircuit",
  "zio",
  "coollabsio",
  "highlight",
  "gyroflow",
  "go-gitea",
  "onyx-dot-app",
  "tailcallhq",
  "permitio",
  "revertinc",
] as const;

export const ALGORA_HELP =
  "Set GITHUB_TOKEN to a classic GitHub personal access token with the public_repo scope (https://github.com/settings/tokens/new?scopes=public_repo&description=work-protocol): apply and submit post /attempt and /claim comments as you, and status reads your own comments. Search and get work without it, at GitHub's lower anonymous limits. Algora pays rewards through Stripe Connect: sign in at https://algora.io with the same GitHub account to receive them.";

/** GitHub caps a search query at 256 characters; keep room for the encoding of the bot's name. */
const MAX_QUERY = 240;
const BASE_QUALIFIERS = `commenter:${ALGORA_BOT} state:open is:issue archived:false`;
const CACHE_MS = 5 * 60_000;
/** Issues whose comments are read per search to confirm and price the bounty. */
const MAX_VERIFY = 30;
const VERIFY_BATCH = 4;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const ISSUE_ID = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9]\d{0,9})$/u;
const ISSUE_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/issues\/([1-9]\d{0,9})\/?(?:[?#].*)?$/u;
const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})\/?(?:[/?#].*)?$/u;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);
const recs = (value: unknown): Rec[] => (Array.isArray(value) ? value.map(rec).filter((r): r is Rec => Boolean(r)) : []);
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const amountOf = (text: string) => Number(text.replace(/,/gu, ""));

// ---- ids ------------------------------------------------------------------------

export type IssueRef = { owner: string; repo: string; number: number };

/** `owner/repo#123`, or the issue's github.com URL. */
export function parseIssueId(nativeId: string): IssueRef | null {
  const text = nativeId.trim();
  const match = ISSUE_ID.exec(text) ?? ISSUE_URL.exec(text);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

export const issueKey = (ref: IssueRef) => `${ref.owner}/${ref.repo}#${ref.number}`;
const issueUrl = (ref: IssueRef) => `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`;

/** The organisations to search: ALGORA_ORGS (comma separated) or the curated default. */
export function orgsFrom(value: string | undefined): string[] {
  const listed = (value ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => OWNER.test(o));
  const chosen = listed.length ? listed : [...DEFAULT_ALGORA_ORGS];
  const seen = new Set<string>();
  return chosen.filter((o) => {
    const key = o.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- reading the bot's comments --------------------------------------------------

export type Sponsor = { name: string; amount: number; url?: string };
export type Award = { login: string; amount: number; at?: string };
export type Claim = { login: string; pr: string; at?: string };
export type Attempt = { login: string; at?: string; url?: string };
export type Bounty = {
  sponsors: Sponsor[];
  total: number;
  /** When the bot first priced the issue. */
  posted_at?: string;
  comment_url?: string;
  awards: Award[];
  claims: Claim[];
  attempts: Attempt[];
};

const SPONSOR_LINE =
  /💎\s*(?:\*\*)?\s*\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:\*\*)?\s*bounty(?:\s*\[•\s*([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\s+created by\s+@?([A-Za-z0-9._-]+))?/gu;
const AWARD = /🎉[^\n]*?@([A-Za-z0-9-]+) has been awarded \*\*\$(\d[\d,]*(?:\.\d+)?)\*\*/u;
const CLAIM = /💡 @([A-Za-z0-9-]+) submitted a \[pull request\]\((https:\/\/github\.com\/[^)\s]+)\) that claims the bounty/u;
const ATTEMPT_COMMAND = /(?:^|\s)\/attempt\s+#?\d+/mu;

const login = (c: Rec) => str(rec(c.user)?.login);

/**
 * The bounty the bot's comments describe, or null when no algora-pbc[bot] comment prices the issue. When more
 * sponsors join, the bot edits its comment or posts a new one that lists every sponsor again (names can
 * change between the two), so the latest pricing comment is the whole bounty.
 */
export function bountyFromComments(comments: Rec[]): Bounty | null {
  let sponsors = new Map<string, Sponsor>();
  const awards: Award[] = [];
  const claims: Claim[] = [];
  const attempts: Attempt[] = [];
  let posted: string | undefined;
  let commentUrl: string | undefined;
  for (const c of comments) {
    const body = str(c.body) ?? "";
    const at = iso(c.created_at);
    const who = login(c);
    if (who !== ALGORA_BOT) {
      if (who && ATTEMPT_COMMAND.test(body))
        attempts.push({ login: who, ...(at ? { at } : {}), ...(str(c.html_url) ? { url: str(c.html_url) } : {}) });
      continue;
    }
    const priced = new Map<string, Sponsor>();
    for (const m of body.matchAll(SPONSOR_LINE)) {
      const amount = amountOf(m[1]!);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const name = (m[2] ?? m[4] ?? "").trim() || "Algora";
      const url = m[3];
      // The sponsor's page (algora.io/<handle>) names them more stably than the display name.
      const handle = url?.replace(/\/+$/u, "").split("/").pop()?.toLowerCase() ?? name.toLowerCase();
      priced.set(handle, { name, amount, ...(url ? { url } : {}) });
    }
    if (priced.size) {
      sponsors = priced;
      posted ??= at;
      commentUrl = str(c.html_url) ?? commentUrl;
    }
    const award = AWARD.exec(body);
    if (award) awards.push({ login: award[1]!, amount: amountOf(award[2]!), ...(at ? { at } : {}) });
    const claim = CLAIM.exec(body);
    if (claim) claims.push({ login: claim[1]!, pr: claim[2]!, ...(at ? { at } : {}) });
  }
  if (!sponsors.size) return null;
  const list = [...sponsors.values()];
  const total = Math.round(list.reduce((sum, s) => sum + s.amount, 0) * 100) / 100;
  return {
    sponsors: list,
    total,
    ...(posted ? { posted_at: posted } : {}),
    ...(commentUrl ? { comment_url: commentUrl } : {}),
    awards,
    claims,
    attempts,
  };
}

// ---- mapping --------------------------------------------------------------------

const REWARDED = "💰 Rewarded";
const ALGORA_LABEL = "💎 Bounty";
const AMOUNT_LABEL = /^\$\s?\d[\d,.]*k?$/iu;
const RESTRICTED = /\b(core[- ]team|maintainers?|staff|internal)[- ]only\b/iu;
const ON_HOLD = /\b(on[- ]hold|hold|blocked|paused)\b/iu;
const AGENT_OK = /\b(ai|agents?|autonomous)\b.*\b(friendly|allowed|welcome|only)\b/iu;
const HUMAN_ONLY = /\bhumans?[- ]only\b|\bno (ai|agents?|bots?|llms?)\b/iu;

const labelsOf = (issue: Rec) =>
  (Array.isArray(issue.labels) ? (issue.labels as unknown[]) : [])
    .map((l) => (typeof l === "string" ? l : str(rec(l)?.name)))
    .filter((l): l is string => Boolean(l));

/** Why nobody new can take the bounty, or undefined when it is open to attempts. */
export function closedReason(issue: Rec, bounty: Bounty | null): string | undefined {
  const labels = labelsOf(issue);
  if (!bounty) return "Algora's bot has not priced this issue, so there is no Algora bounty on it";
  const award = bounty.awards[0];
  if (award) return `Already awarded to @${award.login}`;
  if (labels.includes(REWARDED)) return "Already rewarded";
  if ((str(issue.state) ?? "open") !== "open") return "The issue is closed";
  if (issue.pull_request) return "This is a pull request, not a bounty issue";
  const restricted = labels.find((l) => RESTRICTED.test(l));
  if (restricted) return `Restricted by the label "${restricted}"`;
  const hold = labels.find((l) => ON_HOLD.test(l));
  if (hold) return `On hold (label "${hold}")`;
  return undefined;
}

function repoOf(issue: Rec): IssueRef | null {
  const repo = str(issue.repository_url)?.replace(`${GITHUB_API}/repos/`, "");
  const number = num(issue.number);
  const parts = repo?.split("/") ?? [];
  if (parts.length !== 2 || number === undefined) return null;
  const ref = { owner: parts[0]!, repo: parts[1]!, number };
  return ISSUE_ID.test(issueKey(ref)) ? ref : null;
}

function payOf(bounty: Bounty): Pay {
  const from = bounty.sponsors.map((s) => `${money(s.amount)} from ${s.name}`).join(" + ");
  return {
    min: bounty.total,
    max: bounty.total,
    currency: "USD",
    period: "unit",
    unit: "per merged solution",
    text:
      bounty.sponsors.length > 1
        ? `${money(bounty.total)} in total (${from})`
        : `${money(bounty.total)} from ${bounty.sponsors[0]?.name ?? "Algora"}`,
  };
}

/** One GitHub issue plus its bot-read bounty as a task; null when it is not an Algora bounty. */
export function issueToJob(issue: Rec, bounty: Bounty | null): NativeJob | null {
  const ref = repoOf(issue);
  const title = str(issue.title);
  if (!ref || !title || !bounty || issue.pull_request) return null;
  const url = str(issue.html_url) ?? issueUrl(ref);
  const labels = labelsOf(issue);
  const assignees = recs(issue.assignees)
    .map((a) => str(a.login))
    .filter((a): a is string => Boolean(a));
  const reason = closedReason(issue, bounty);
  const body = str(issue.body);
  const posted = bounty.posted_at ?? iso(issue.created_at);
  const agent = labels.some((l) => HUMAN_ONLY.test(l)) ? "human-only" : labels.some((l) => AGENT_OK.test(l)) ? "agent-allowed" : undefined;
  const shown = labels.filter((l) => l !== ALGORA_LABEL && !AMOUNT_LABEL.test(l) && !AGENT_OK.test(l) && !HUMAN_ONLY.test(l)).slice(0, 5);
  const attempters = [...new Set(bounty.attempts.map((a) => a.login))];
  const claimers = [...new Set(bounty.claims.map((c) => c.login))];
  const n = ref.number;
  const crowd = [
    attempters.length ? `${plural(attempters.length, "person")} attempted it` : "",
    claimers.length ? `${plural(claimers.length, "pull request")} already claim it` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return {
    id: issueKey(ref),
    kind: "task",
    title,
    org: bounty.sponsors.length === 1 ? bounty.sponsors[0]!.name : `${ref.owner}/${ref.repo}`,
    location: { remote: true, text: "Remote, anywhere Stripe Connect pays out" },
    pay: payOf(bounty),
    ...(body ? { summary: stripHtml(body, 300), description: stripHtml(body, 6000) } : {}),
    url,
    ...(posted ? { posted_at: posted } : {}),
    tags: [
      ...shown,
      `${ref.owner}/${ref.repo}`,
      ...(agent ? [agent] : []),
      ...(attempters.length ? [`${plural(attempters.length, "attempt")}`] : []),
      ...(claimers.length ? [`${plural(claimers.length, "claim")}`] : []),
      ...(assignees.length ? ["assigned"] : []),
      "source:algora",
    ],
    ...(reason ? { stages: ["search", "get"] } : { participation_mode: "claim" as const }),
    apply_hint: reason
      ? `${reason}. ${url}`
      : `${crowd ? `${crowd}; read the thread first. ` : ""}apply drafts "/attempt #${n}" for the issue; submit with the confirmation posts it as you. Then open a pull request that fixes it and submit with note "pr:<PR URL>" to draft "/claim #${n}" for it, then confirm. Algora pays after the maintainers merge and award it.`,
    requirements: {
      how_to: [
        `apply drafts the "/attempt #${n}" comment (your plan goes in note); submit with note "confirm:<token>" posts it on the issue as you.`,
        "Fix the issue in a pull request you open yourself.",
        `submit with note "pr:<PR URL>" drafts "/claim #${n}" for that pull request and returns a confirm token to post it; or put "/claim #${n}" in its description.`,
        "The maintainers review and merge, then award the bounty on Algora. The reward goes to the Algora account of the pull request's author, through Stripe Connect.",
      ],
      rules: [
        "The pull request author gets paid, so open it from the GitHub account whose token is used here.",
        ...(assignees.length ? [`Assigned on GitHub to ${assignees.map((a) => `@${a}`).join(", ")}`] : []),
        ...(agent === "human-only" ? ["The maintainers ask for human contributors only."] : []),
      ],
    },
    raw: {
      repo: `${ref.owner}/${ref.repo}`,
      number: n,
      state: str(issue.state) ?? "open",
      labels,
      sponsors: bounty.sponsors,
      total_usd: bounty.total,
      bounty_comment: bounty.comment_url ?? null,
      attempts: attempters,
      claims: bounty.claims,
      awards: bounty.awards,
      comments: num(issue.comments) ?? 0,
      ...(assignees.length ? { assignees } : {}),
    },
  };
}

// ---- GitHub -------------------------------------------------------------------------

type Resource = "search" | "core";
type Call = { label: string; resource?: Resource; method?: "GET" | "POST"; body?: unknown; token?: string; cache?: boolean };
type Answer<T> = { body: T; headers: Headers };
type HttpState = { cache: Map<string, { at: number; answer: Answer<unknown> }>; blockedUntil: Map<string, number> };

// One state per fetch implementation, so hosts and tests that bring their own fetch never share bodies or limits.
const states = new WeakMap<typeof fetch, HttpState>();
function httpState(fetchImpl: typeof fetch): HttpState {
  let state = states.get(fetchImpl);
  if (!state) {
    state = { cache: new Map(), blockedUntil: new Map() };
    states.set(fetchImpl, state);
  }
  return state;
}

function rateLimited(seconds: number, resource: Resource, token: boolean): ProtocolError {
  return new ProtocolError("rate_limited", `GitHub's ${resource} rate limit is used up.${token ? "" : ` ${ALGORA_HELP}`}`, {
    connector: ID,
    retry_after: Math.max(1, Math.ceil(seconds)),
  });
}

/** One request to the GitHub REST API, with its rate-limit answers kept apart from auth failures. */
async function github<T>(ctx: ConnectorContext, target: string | URL, call: Call): Promise<Answer<T>> {
  const url = String(target).startsWith("/") ? `${GITHUB_API}${String(target)}` : String(target);
  const method = call.method ?? (call.body === undefined ? "GET" : "POST");
  const resource = call.resource ?? "core";
  const state = httpState(ctx.fetch);
  const token = call.token ?? ctx.credentials[TOKEN_ENV]?.trim();
  const cacheKey = `${token ? "t" : "a"} ${url}`;
  if (method === "GET" && call.cache) {
    const hit = state.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.answer as Answer<T>;
  }
  const gate = `${resource}:${token ? "token" : "anonymous"}`;
  const until = state.blockedUntil.get(gate) ?? 0;
  if (until > Date.now()) throw rateLimited((until - Date.now()) / 1000, resource, Boolean(token));
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      signal: ctx.signal,
    });
  } catch (error) {
    throw toProtocolError(error, ID);
  }
  const remaining = num(response.headers.get("x-ratelimit-remaining"));
  const reset = num(response.headers.get("x-ratelimit-reset"));
  if (remaining === 0 && reset !== undefined) state.blockedUntil.set(gate, reset * 1000);
  if (response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ProtocolError("upstream_error", `GitHub did not answer ${call.label} with JSON.`, { connector: ID, cause: error });
    }
    const answer = { body: body as T, headers: response.headers };
    if (method === "GET" && call.cache) state.cache.set(cacheKey, { at: Date.now(), answer });
    return answer;
  }
  let message = "";
  try {
    const text = await response.text();
    try {
      message = str(rec(JSON.parse(text))?.message) ?? text.slice(0, 200);
    } catch {
      message = text.slice(0, 200);
    }
  } catch {
    // keep the status alone
  }
  const status = response.status;
  const details = { status };
  const retry = num(response.headers.get("retry-after"));
  if (status === 429 || (status === 403 && (remaining === 0 || retry !== undefined || /rate limit/iu.test(message)))) {
    const wait = Math.max(1, retry ?? (reset !== undefined ? reset - Date.now() / 1000 : 60));
    state.blockedUntil.set(gate, Date.now() + wait * 1000);
    throw rateLimited(wait, resource, Boolean(token));
  }
  const said = message ? `: ${message}` : ".";
  if (status === 403 && /locked/iu.test(message)) {
    throw new ProtocolError("wrong_stage", `GitHub refused ${call.label}: the conversation is locked${said}`, { connector: ID, details });
  }
  if (status === 401 || status === 403) {
    const lead = token ? `GitHub refused the token for ${call.label} (${status})${said}` : `GitHub needs a token for ${call.label}.`;
    throw new ProtocolError("auth_required", `${lead} ${ALGORA_HELP}`, { connector: ID, details });
  }
  if (status === 404 || status === 410) {
    throw new ProtocolError("not_found", `GitHub has nothing at ${call.label}.`, { connector: ID, details });
  }
  throw new ProtocolError(status >= 500 ? "upstream_error" : "invalid_input", `GitHub answered ${call.label} with ${status}${said}`, {
    connector: ID,
    details,
  });
}

function requireToken(ctx: ConnectorContext): string {
  const token = ctx.credentials[TOKEN_ENV]?.trim();
  if (!token) throw new ProtocolError("auth_required", ALGORA_HELP, { connector: ID });
  return token;
}

// ---- the person's attempts, kept on disk -----------------------------------------------

type Entry = {
  issue: string;
  title?: string;
  url: string;
  stage: "staged" | "attempted" | "claimed";
  /** The comment apply drafted, waiting for its confirmation. */
  comment?: string;
  nonce: string;
  login?: string;
  attempt_url?: string;
  claim_url?: string;
  pr?: string;
  /** The /claim comment drafted for a pull request, waiting for its confirmation. */
  pending_claim?: { pr: string; command: string };
  total_usd?: number;
  at: string;
  updated_at: string;
};

function defaultStateFile(env: NodeJS.ProcessEnv): string {
  const base = stateDir(env);
  return path.join(base, "algora-attempts.json");
}

class Attempts {
  private memory: Record<string, Entry> | undefined;

  constructor(private readonly file: string | null) {}

  private load(): Record<string, Entry> {
    if (this.memory) return this.memory;
    this.memory = {};
    if (this.file) {
      try {
        this.memory = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Entry>;
      } catch {
        // nothing saved yet
      }
    }
    return this.memory;
  }

  get(key: string): Entry | undefined {
    return this.load()[key];
  }

  all(): Entry[] {
    return Object.values(this.load());
  }

  set(entry: Entry): void {
    const all = this.load();
    all[entry.issue] = entry;
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(all, null, 2));
    } catch {
      // memory still holds it for this process
    }
  }
}

/** The token that confirms posting exactly this comment on exactly this issue. */
export function confirmToken(entry: Pick<Entry, "nonce" | "issue" | "comment">): string {
  return createHash("sha256")
    .update(entry.nonce)
    .update(JSON.stringify([entry.issue, entry.comment ?? ""]))
    .digest("hex")
    .slice(0, 12);
}

/** The token that confirms posting exactly this /claim on exactly this pull request. */
export function claimToken(entry: Pick<Entry, "nonce" | "issue" | "pending_claim">): string {
  return createHash("sha256")
    .update(entry.nonce)
    .update(JSON.stringify([entry.issue, entry.pending_claim?.pr ?? "", entry.pending_claim?.command ?? ""]))
    .digest("hex")
    .slice(0, 12);
}

const PAID_HOW =
  "Algora pays the award through Stripe Connect to the Algora account of the pull request's author: sign in at https://algora.io with that GitHub account and finish the payout setup.";

function preview(entry: Entry): string {
  return `Nothing is posted yet. Show the person this comment, which goes on ${entry.url}${entry.login ? ` as @${entry.login}` : ""}:\n\n${entry.comment ?? ""}\n\nThen submit with note "confirm:${confirmToken(entry)}" to post it.`;
}

function claimNext(n: number, login: string | undefined): string {
  return `Fix the issue in a pull request${login ? ` opened by @${login}` : " you open yourself"} (Algora pays the pull request's author), then submit with note "pr:<PR URL>" to draft "/claim #${n}" and confirm it, or put "/claim #${n}" in its description.`;
}

// ---- the connector ----------------------------------------------------------------------

export type AlgoraOptions = {
  /** Organisations to search. Default: ALGORA_ORGS, else DEFAULT_ALGORA_ORGS. */
  orgs?: string[];
  /** Read for ALGORA_ORGS and WORK_CACHE_DIR. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Where attempts are remembered. Default algora-attempts.json in WORK_CACHE_DIR or ~/.cache/work-protocol; null keeps them in memory. */
  stateFile?: string | null;
};

export function createAlgora(options: AlgoraOptions = {}) {
  const env = () => options.env ?? process.env;
  let attempts: Attempts | undefined;
  const store = perTenant(() => new Attempts(options.stateFile === undefined ? defaultStateFile(env()) : options.stateFile));
  const orgs = () => (options.orgs?.length ? orgsFrom(options.orgs.join(",")) : orgsFrom(env().ALGORA_ORGS));

  const issueOf = async (ctx: ConnectorContext, ref: IssueRef, cache = false) =>
    rec(
      (await github<unknown>(ctx, `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, { label: `issue ${issueKey(ref)}`, cache })).body,
    ) ?? {};

  const commentsOf = async (ctx: ConnectorContext, ref: IssueRef, cache = false) =>
    recs(
      (
        await github<unknown>(ctx, `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`, {
          label: `the comments on ${issueKey(ref)}`,
          cache,
        })
      ).body,
    );

  async function me(ctx: ConnectorContext, token: string): Promise<{ user: Rec; scopes: string | null }> {
    const { body, headers } = await github<unknown>(ctx, "/user", { label: "your GitHub account", token });
    const user = rec(body) ?? {};
    if (!str(user.login)) throw new ProtocolError("upstream_error", "GitHub answered /user without a login.", { connector: ID });
    return { user, scopes: headers.get("x-oauth-scopes") };
  }

  async function bountyIssue(ctx: ConnectorContext, ref: IssueRef): Promise<{ issue: Rec; bounty: Bounty | null }> {
    const [issue, comments] = await Promise.all([issueOf(ctx, ref), commentsOf(ctx, ref)]);
    return { issue, bounty: bountyFromComments(comments) };
  }

  async function post(ctx: ConnectorContext, ref: IssueRef, body: string, token: string, label: string): Promise<Rec> {
    const answer = await github<unknown>(ctx, `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, {
      label,
      method: "POST",
      body: { body },
      token,
    });
    return rec(answer.body) ?? {};
  }

  function toApplication(
    entry: Entry,
    stage: NativeApplication["stage"],
    next: string,
    extra: Partial<NativeApplication> = {},
  ): NativeApplication {
    return {
      id: entry.issue,
      job_id: entry.issue,
      ...(entry.title ? { job_title: entry.title } : {}),
      stage,
      next,
      url: entry.claim_url ?? entry.attempt_url ?? entry.url,
      created_at: entry.at,
      updated_at: entry.updated_at,
      raw: {
        local_stage: entry.stage,
        ...(entry.login ? { login: entry.login } : {}),
        ...(entry.attempt_url ? { attempt_comment: entry.attempt_url } : {}),
        ...(entry.pr ? { pull_request: entry.pr } : {}),
        ...(entry.claim_url ? { claim_comment: entry.claim_url } : {}),
        ...(entry.stage === "staged" ? { comment: entry.comment ?? "", confirm: confirmToken(entry) } : {}),
        ...(entry.total_usd !== undefined ? { total_usd: entry.total_usd } : {}),
      },
      ...extra,
    };
  }

  function localView(entry: Entry): NativeApplication {
    const n = parseIssueId(entry.issue)?.number ?? 0;
    if (entry.stage === "staged") return toApplication(entry, "work_needed", preview(entry));
    if (entry.stage === "attempted") return toApplication(entry, "work_needed", `Attempt posted. ${claimNext(n, entry.login)}`);
    return toApplication(
      entry,
      "in_review",
      `Claim posted on ${entry.pr ?? "the pull request"}. The maintainers review and merge, then award the bounty. ${PAID_HOW}`,
    );
  }

  function newEntry(ref: IssueRef, issue: Rec, bounty: Bounty | null, login: string | undefined): Entry {
    const now = new Date().toISOString();
    const title = str(issue.title);
    return {
      issue: issueKey(ref),
      ...(title ? { title } : {}),
      url: str(issue.html_url) ?? issueUrl(ref),
      stage: "staged",
      nonce: randomBytes(9).toString("hex"),
      ...(login ? { login } : {}),
      ...(bounty ? { total_usd: bounty.total } : {}),
      at: now,
      updated_at: now,
    };
  }

  function parseOrThrow(nativeId: string): IssueRef {
    const ref = parseIssueId(nativeId);
    if (!ref) {
      throw new ProtocolError("not_found", `Algora bounty ids look like owner/repo#123; ${JSON.stringify(nativeId)} is not one.`, {
        connector: ID,
      });
    }
    return ref;
  }

  async function claim(ctx: ConnectorContext, ref: IssueRef, prUrl: string, token: string): Promise<NativeApplication> {
    const match = PULL_URL.exec(prUrl);
    if (!match) {
      throw new ProtocolError(
        "invalid_input",
        `"pr:" takes the pull request's github.com URL, like https://github.com/${ref.owner}/${ref.repo}/pull/123.`,
        {
          connector: ID,
        },
      );
    }
    const pr: IssueRef = { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
    const prLink = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
    const [{ user }, pull, { issue, bounty }] = await Promise.all([
      me(ctx, token),
      github<unknown>(ctx, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, { label: `pull request ${prLink}` }).then(
        (a) => rec(a.body) ?? {},
      ),
      bountyIssue(ctx, ref),
    ]);
    const self = str(user.login)!;
    const author = str(rec(pull.user)?.login);
    if (!author || author.toLowerCase() !== self.toLowerCase()) {
      throw new ProtocolError(
        "invalid_input",
        `Algora pays the pull request's author, and ${prLink} was opened by ${author ? `@${author}` : "someone else"}, not @${self}. Claim with a pull request you opened yourself.`,
        { connector: ID, details: { author: author ?? null, you: self } },
      );
    }
    if (str(pull.state) === "closed" && !pull.merged_at && pull.merged !== true) {
      throw new ProtocolError("wrong_stage", `${prLink} is closed without being merged; reopen it or open a new one before claiming.`, {
        connector: ID,
        details: { stage: "closed" },
      });
    }
    const reason = closedReason(issue, bounty);
    if (reason)
      throw new ProtocolError("wrong_stage", `${reason}: nothing to claim on ${issueKey(ref)}.`, {
        connector: ID,
        details: { stage: "closed" },
      });
    const key = issueKey(ref);
    const entry = store().get(key) ?? newEntry(ref, issue, bounty, self);
    if (entry.stage === "claimed" && entry.pr === prLink) return localView(entry);
    const sameRepo = pr.owner.toLowerCase() === ref.owner.toLowerCase() && pr.repo.toLowerCase() === ref.repo.toLowerCase();
    const command = `/claim ${sameRepo ? `#${ref.number}` : issueUrl(ref)}`;
    const already = new RegExp(`/claim\\s+(?:#${ref.number}|${issueUrl(ref).replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")})\\b`, "u").test(
      str(pull.body) ?? "",
    );
    if (already) return markClaimed(entry, self, prLink, prLink, `${prLink} already says "${command}" in its description`);
    // The claim is a public comment posted as the person: draft it, and post only on their confirmation.
    const pending: Entry = { ...entry, login: self, pending_claim: { pr: prLink, command }, updated_at: new Date().toISOString() };
    store().set(pending);
    return toApplication(
      pending,
      "work_needed",
      `Nothing is posted yet. Show the person this comment, which goes on ${prLink} as @${self}:\n\n${command}\n\nThen submit with note "confirm:${claimToken(pending)}" to post it.`,
    );
  }

  function markClaimed(entry: Entry, self: string, prLink: string, claimUrl: string, done: string): NativeApplication {
    const updated: Entry = {
      ...entry,
      stage: "claimed",
      login: self,
      pr: prLink,
      claim_url: claimUrl,
      updated_at: new Date().toISOString(),
    };
    delete updated.comment;
    delete updated.pending_claim;
    store().set(updated);
    return toApplication(updated, "in_review", `${done}. The maintainers review and merge, then award the bounty on Algora. ${PAID_HOW}`);
  }

  /** Posts the drafted /claim once its confirmation matches. */
  async function postClaim(ctx: ConnectorContext, ref: IssueRef, entry: Entry, token: string): Promise<NativeApplication> {
    const { pr: prLink, command } = entry.pending_claim!;
    const match = PULL_URL.exec(prLink)!;
    const pr: IssueRef = { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
    const { issue, bounty } = await bountyIssue(ctx, ref);
    const reason = closedReason(issue, bounty);
    if (reason)
      throw new ProtocolError("wrong_stage", `${reason}: the claim was not posted.`, { connector: ID, details: { stage: "closed" } });
    const posted = await post(ctx, pr, command, token, `the claim on ${prLink}`);
    const self = str(rec(posted.user)?.login) ?? entry.login ?? "";
    return markClaimed(entry, self, prLink, str(posted.html_url) ?? prLink, `Posted "${command}" on ${prLink}`);
  }

  async function statusOf(nativeApplicationId: string, ctx: ConnectorContext): Promise<NativeApplication | null> {
    const token = requireToken(ctx);
    const ref = parseIssueId(nativeApplicationId);
    if (!ref) return null;
    const key = issueKey(ref);
    const [{ user }, { issue, bounty }] = await Promise.all([me(ctx, token), bountyIssue(ctx, ref)]);
    const self = str(user.login)!;
    const same = (who: string) => who.toLowerCase() === self.toLowerCase();
    let entry = store().get(key);
    const attempt = bounty?.attempts.find((a) => same(a.login));
    const claimed = bounty?.claims.find((c) => same(c.login));
    if (!entry && !attempt && !claimed) return null;
    entry ??= newEntry(ref, issue, bounty, self);
    if (claimed && entry.stage !== "claimed") entry = { ...entry, stage: "claimed", pr: claimed.pr };
    else if (attempt && entry.stage === "staged")
      entry = { ...entry, stage: "attempted", ...(attempt.url ? { attempt_url: attempt.url } : {}) };
    if (entry.stage !== "staged") delete entry.comment;
    entry = { ...entry, login: self, ...(bounty ? { total_usd: bounty.total } : {}) };
    store().set(entry);
    const won = bounty?.awards.find((a) => same(a.login));
    if (won) {
      return toApplication(entry, "accepted", `Awarded ${money(won.amount)}. ${PAID_HOW}`, {
        review: { earned: { amount: won.amount, currency: "USD" } },
        ...(won.at ? { updated_at: won.at } : {}),
      });
    }
    const other = bounty?.awards[0];
    if (other) return toApplication(entry, "closed", `Awarded to @${other.login}, not you.`);
    if (labelsOf(issue).includes(REWARDED)) return toApplication(entry, "closed", "The bounty was rewarded to someone else.");
    if ((str(issue.state) ?? "open") !== "open")
      return toApplication(entry, "closed", `The issue was closed without an award to you: ${entry.url}`);
    if (!bounty) return toApplication(entry, "closed", "Algora's bounty comment is gone from the issue; the bounty was likely withdrawn.");
    return localView(entry);
  }

  return defineConnector({
    id: ID,
    name: "Algora",
    description:
      "Open-source bounties on GitHub issues priced through Algora, paid in fiat via Stripe Connect when the maintainers merge and award your fix. Find bounties in a curated set of organisations (ALGORA_ORGS), then post /attempt and /claim as yourself with a GitHub token.",
    homepage: "https://algora.io",
    kinds: ["task"],
    category: "bounty",
    tier: "discover",
    sharedLimitWithoutKey: true,
    payoutRails: ["fiat"],
    auth: { type: "api_key", env: [TOKEN_ENV], help: ALGORA_HELP, required: false },

    async search(query, ctx) {
      const limit = query.limit ?? 20;
      // Qualifiers in the words could widen the search past the trusted organisations: drop them.
      const words = (query.query ?? "")
        .replace(/(?:^|\s)-?[A-Za-z_]+:\S+/gu, " ")
        .replace(/["\\]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 80);
      const batches: string[][] = [];
      for (const org of orgs()) {
        const current = batches[batches.length - 1];
        const q = (list: string[]) => [words, ...list.map((o) => `org:${o}`), BASE_QUALIFIERS].filter(Boolean).join(" ");
        if (current && q([...current, org]).length <= MAX_QUERY) current.push(org);
        else batches.push([org]);
      }
      const items: Rec[] = [];
      let total = 0;
      for (const batch of batches) {
        const url = new URL(`${GITHUB_API}/search/issues`);
        url.searchParams.set("q", [words, ...batch.map((o) => `org:${o}`), BASE_QUALIFIERS].filter(Boolean).join(" "));
        if (!words) {
          url.searchParams.set("sort", "updated");
          url.searchParams.set("order", "desc");
        }
        url.searchParams.set("per_page", "50");
        const body = rec((await github<unknown>(ctx, url, { label: "the issue search", resource: "search", cache: true })).body) ?? {};
        total += num(body.total_count) ?? 0;
        items.push(...recs(body.items));
      }
      const seen = new Set<string>();
      const candidates = items
        .filter((item) => !item.pull_request && !labelsOf(item).includes(REWARDED))
        .filter((item) => {
          const ref = repoOf(item);
          if (!ref || seen.has(issueKey(ref))) return false;
          seen.add(issueKey(ref));
          return true;
        })
        .sort((a, b) => (str(b.updated_at) ?? "").localeCompare(str(a.updated_at) ?? ""))
        .slice(0, MAX_VERIFY);
      const jobs: NativeJob[] = [];
      let checked = 0;
      let firstError: unknown;
      let stopped = false;
      // Only the bot's own comment proves and prices a bounty, so each candidate's comments are read.
      while (checked < candidates.length && jobs.length < limit && !stopped) {
        const batch = candidates.slice(checked, checked + VERIFY_BATCH);
        checked += batch.length;
        const results = await Promise.allSettled(batch.map((item) => commentsOf(ctx, repoOf(item)!, true)));
        results.forEach((result, i) => {
          if (result.status === "rejected") {
            firstError ??= result.reason;
            if (result.reason instanceof ProtocolError && result.reason.code === "rate_limited") stopped = true;
            return;
          }
          const issue = batch[i]!;
          const bounty = bountyFromComments(result.value);
          if (closedReason(issue, bounty)) return;
          const job = issueToJob(issue, bounty);
          if (job) jobs.push(job);
        });
      }
      if (!jobs.length && firstError) throw toProtocolError(firstError, ID);
      const filtered = applyFilters(jobs, query, { query: true, remote: true });
      return {
        jobs: filtered.slice(0, limit),
        more: stopped || checked < candidates.length || total > items.length || filtered.length > limit,
      };
    },

    async get(nativeId, ctx) {
      const ref = parseIssueId(nativeId);
      if (!ref) return null;
      try {
        const [issue, comments] = await Promise.all([issueOf(ctx, ref, true), commentsOf(ctx, ref, true)]);
        return issueToJob(issue, bountyFromComments(comments));
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "not_found") return null;
        throw error;
      }
    },

    async apply(nativeId, input, ctx) {
      const token = requireToken(ctx);
      const ref = parseOrThrow(nativeId);
      const key = issueKey(ref);
      const [{ user }, issue, comments] = await Promise.all([me(ctx, token), issueOf(ctx, ref), commentsOf(ctx, ref)]);
      const self = str(user.login)!;
      const bounty = bountyFromComments(comments);
      const existing = store().get(key);
      if (existing && existing.stage !== "staged") return localView(existing);
      const reason = closedReason(issue, bounty);
      if (reason)
        throw new ProtocolError("wrong_stage", `${reason}: ${key} takes no new attempts.`, { connector: ID, details: { stage: "closed" } });
      const mine = bounty?.attempts.find((a) => a.login.toLowerCase() === self.toLowerCase());
      if (mine) {
        const entry: Entry = {
          ...newEntry(ref, issue, bounty, self),
          stage: "attempted",
          ...(mine.url ? { attempt_url: mine.url } : {}),
          ...(mine.at ? { at: mine.at } : {}),
        };
        store().set(entry);
        return localView(entry);
      }
      const plan = input.note?.trim();
      const entry: Entry = {
        ...newEntry(ref, issue, bounty, self),
        ...(existing ? { at: existing.at } : {}),
        comment: `/attempt #${ref.number}${plan ? `\n\n${truncate(plan, 1800)}` : ""}`,
      };
      store().set(entry);
      const others = [...new Set((bounty?.attempts ?? []).map((a) => a.login))];
      const app = localView(entry);
      return others.length
        ? {
            ...app,
            next: `${plural(others.length, "other person")} already attempted this (${others.map((o) => `@${o}`).join(", ")}); read the thread before starting. ${app.next}`,
          }
        : app;
    },

    async submit(nativeApplicationId, input, ctx) {
      const token = requireToken(ctx);
      const ref = parseOrThrow(nativeApplicationId);
      const key = issueKey(ref);
      const note = input.note?.trim() ?? "";
      if (/^pr:/iu.test(note)) return claim(ctx, ref, note.slice(3).trim(), token);
      const entry = store().get(key);
      if (!entry) {
        throw new ProtocolError(
          "not_ready",
          `Nothing drafted for ${key}: apply first, or submit with note "pr:<PR URL>" to claim with a pull request you opened.`,
          {
            connector: ID,
          },
        );
      }
      if (entry.pending_claim && note === `confirm:${claimToken(entry)}`) return postClaim(ctx, ref, entry, token);
      if (entry.stage !== "staged") {
        if (entry.pending_claim && /^confirm:/iu.test(note))
          throw new ProtocolError(
            "invalid_input",
            `That confirmation does not match the drafted claim. Submit with note "pr:${entry.pending_claim.pr}" again for a fresh preview.`,
            { connector: ID },
          );
        if (/^confirm:/iu.test(note)) return localView(entry);
        throw new ProtocolError("invalid_input", `The attempt is already posted. ${claimNext(ref.number, entry.login)}`, {
          connector: ID,
          details: { stage: entry.stage },
        });
      }
      const expected = confirmToken(entry);
      if (note !== `confirm:${expected}`) {
        throw new ProtocolError(
          "invalid_input",
          note.toLowerCase().startsWith("confirm:")
            ? `That confirmation does not match the drafted comment. Read it again with status, show the person the preview, and submit with the note "confirm:<token>" it gives.`
            : `The attempt is a public comment on GitHub posted as the person. Show them the preview from apply first, then submit with the note "confirm:<token>" it gives.`,
          { connector: ID },
        );
      }
      const { issue, bounty } = await bountyIssue(ctx, ref);
      const reason = closedReason(issue, bounty);
      if (reason)
        throw new ProtocolError("wrong_stage", `${reason}: the attempt was not posted.`, { connector: ID, details: { stage: "closed" } });
      const posted = await post(ctx, ref, entry.comment ?? `/attempt #${ref.number}`, token, `the attempt on ${key}`);
      const updated: Entry = {
        ...entry,
        stage: "attempted",
        ...(str(posted.html_url) ? { attempt_url: str(posted.html_url) } : {}),
        ...(str(rec(posted.user)?.login) ? { login: str(rec(posted.user)?.login) } : {}),
        ...(bounty ? { total_usd: bounty.total } : {}),
        updated_at: new Date().toISOString(),
      };
      delete updated.comment;
      store().set(updated);
      return toApplication(
        updated,
        "work_needed",
        `Attempt posted${updated.attempt_url ? `: ${updated.attempt_url}` : ""}. ${claimNext(ref.number, updated.login)}`,
      );
    },

    status: statusOf,

    async list(ctx) {
      const entries = store().all();
      if (!entries.length) return [];
      requireToken(ctx);
      const out: NativeApplication[] = [];
      for (const entry of entries.sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
        try {
          out.push((await statusOf(entry.issue, ctx)) ?? localView(entry));
        } catch (error) {
          if (error instanceof ProtocolError && (error.code === "auth_required" || error.code === "rate_limited")) throw error;
          out.push(localView(entry));
        }
      }
      return out;
    },

    async link(nativeApplicationId) {
      const ref = parseOrThrow(nativeApplicationId);
      const entry = store().get(issueKey(ref));
      return { url: entry?.claim_url ?? entry?.attempt_url ?? issueUrl(ref) };
    },

    async account(ctx) {
      const token = ctx.credentials[TOKEN_ENV]?.trim();
      if (!token) return { signed_in: false, ready: false, missing: [TOKEN_ENV], help: ALGORA_HELP };
      const { user, scopes } = await me(ctx, token);
      // Classic tokens list their scopes; fine-grained tokens send none and cannot comment on other people's repositories.
      const granted = scopes === null ? null : scopes.split(",").map((s) => s.trim());
      const canComment = granted !== null && (granted.includes("public_repo") || granted.includes("repo"));
      const label = str(user.login)!;
      return {
        signed_in: true,
        label,
        ready: canComment,
        ...(canComment
          ? {}
          : {
              missing: [
                granted === null
                  ? "a classic token (fine-grained tokens cannot comment on other people's repositories)"
                  : "the public_repo scope",
              ],
            }),
        profile: { login: label, name: user.name ?? null, html_url: user.html_url ?? null, scopes: granted },
        help: canComment ? PAID_HOW : ALGORA_HELP,
      };
    },
  });
}

export const algora = createAlgora();
