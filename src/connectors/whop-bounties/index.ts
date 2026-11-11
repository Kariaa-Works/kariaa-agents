/**
 * Whop bounties through the REST API (https://api.whop.com/api/v1): paid clipping, UGC, engagement and
 * data-capture tasks whose reward sits in escrow and pays out per accepted submission. One bounty reads
 * without a credential; searching, submitting work, following reviews, the balance and payouts take a
 * Whop user OAuth token.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConnector, type ConnectorContext } from "../../core/connector.js";
import { ProtocolError, toProtocolError } from "../../core/errors.js";
import { applyFilters, iso, num, str, strings } from "../../core/jsonBoard.js";
import { stripHtml, truncate } from "../../core/text.js";
import type {
  ApplicationFile,
  ApplyInput,
  Earning,
  NativeApplication,
  NativeEarnings,
  NativeJob,
  NativePayout,
  WorkReceipt,
} from "../../core/types.js";
import { USER_AGENT } from "../../core/version.js";
import { perTenant, stateDir } from "../../core/tenant.js";

export const WHOP_API = "https://api.whop.com/api/v1";
/** The dated API version these shapes follow. Without the header Whop serves its legacy surface. */
export const WHOP_API_VERSION = "2026-10-15-1";
const ID = "whop-bounties";
const LABEL = "Whop";
const TOKEN_ENV = "WHOP_OAUTH_TOKEN";
export const WHOP_HELP =
  "Sign in with Whop on the Kariaa Integrations page, or set WHOP_OAUTH_TOKEN to a Whop user OAuth token: create an app at https://whop.com/dashboard/developer with the scopes bounty:basic:read, bounty:submission:create, user:balance:read, payout:withdrawal:read, payout:destination:read and payout:withdraw_funds, then sign in through it (https://docs.whop.com/developer/guides/oauth). An access token lasts one hour. Reading a bounty by id needs no token.";

const MAX_LINKS = 10;
const MAX_FILES = 10;
const BOUNTY_ID = /^bnty_[A-Za-z0-9]+$/u;
const SUBMISSION_ID = /^btys_[A-Za-z0-9]+$/u;
const LINK = /https?:\/\/[^\s<>"']+/giu;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);
const recs = (value: unknown): Rec[] => (Array.isArray(value) ? value.map(rec).filter((r): r is Rec => Boolean(r)) : []);
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Down to the cent, so a whole-balance payout never asks for more than the balance holds. */
const floor2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const upper = (currency: unknown) => (str(currency) ?? "usd").toUpperCase();

const GOAL_TAGS: Record<string, string> = {
  clipping: "clipping",
  post_engagement: "post-engagement",
  owned_account_growth: "account-growth",
  ugc_content: "ugc",
  local_activation: "local-activation",
  data_capture: "data-capture",
};

// ---- countries --------------------------------------------------------------

let regionNames: Intl.DisplayNames | null | undefined;
let codesByName: Map<string, string> | undefined;
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "ZZ", "QO", "XA", "XB"]);
const ALIASES: Record<string, string> = {
  uk: "GB",
  england: "GB",
  "great britain": "GB",
  usa: "US",
  america: "US",
  "united states of america": "US",
};

/** "United States" for "US"; the code itself when the runtime has no region names. */
export function countryName(code: string): string {
  const cc = code.toUpperCase();
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(cc) ?? cc;
  } catch {
    return cc;
  }
}

function nameIndex(): Map<string, string> {
  if (codesByName) return codesByName;
  codesByName = new Map();
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters) {
    for (const b of letters) {
      const code = `${a}${b}`;
      const name = countryName(code);
      if (name !== code && !NOT_COUNTRIES.has(code)) codesByName.set(name.toLowerCase(), code);
    }
  }
  return codesByName;
}

/** The ISO 3166 alpha-2 code of a place the person names ("GH", "Ghana", "Accra, Ghana"), or undefined. */
export function countryCode(place: string | undefined): string | undefined {
  const text = place?.trim().toLowerCase();
  if (!text) return undefined;
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const candidate of [parts[parts.length - 1], text]) {
    if (!candidate) continue;
    const alias = ALIASES[candidate];
    if (alias) return alias;
    if (/^[a-z]{2}$/u.test(candidate)) {
      const cc = candidate.toUpperCase();
      if (!NOT_COUNTRIES.has(cc) && countryName(cc) !== cc) return cc;
    }
    const found = nameIndex().get(candidate);
    if (found) return found;
  }
  return undefined;
}

// ---- mapping ----------------------------------------------------------------

function isCapture(b: Rec | undefined): boolean {
  if (!b) return false;
  return str(b.business_goal_type) === "data_capture" || strings(b.accepted_deliverable_types).includes("data_capture");
}

function duration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = seconds / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

function reward(b: Rec | undefined): { amount: number; currency: string } | undefined {
  const amount = num(b?.net_reward_amount) ?? num(b?.gross_reward_amount);
  return amount === undefined ? undefined : { amount, currency: upper(b?.currency) };
}

// Capture metadata travels with the claim only: submit takes no payload and a submission has no update.
const CAPTURE_FIELDS = ["city", "country", "device", "fov", "operator", "site", "station"] as const;
/** Every field but fov is required once a claim carries any metadata. */
const CAPTURE_REQUIRED: readonly string[] = CAPTURE_FIELDS.filter((f) => f !== "fov");
const CAPTURE_QUESTIONS: Record<string, string> = {
  city: "City the footage is recorded in",
  country: "Country the footage is recorded in, such as US",
  device: "Device the footage is recorded on, such as iPhone 15 Pro",
  fov: "Horizontal field of view in whole degrees, such as 120",
  operator: "Identifier of the person recording",
  site: "Site or venue of the recording",
  station: "Station or position within the site",
};

const listedFields = (b: Rec | undefined) => strings(rec(b?.capture_spec)?.required_metadata_fields);

/** The metadata a claim must carry: none, or every field but fov plus what the capture spec lists once any is given or listed. */
function captureNeeds(b: Rec | undefined, given = false): string[] {
  const listed = listedFields(b);
  return given || listed.length ? [...new Set([...CAPTURE_REQUIRED, ...listed])] : [];
}

/** One bounty (list row or detail) as a task. */
/**
 * Paid engagement: following, liking, commenting or posting on order ("Follow @x & engage", "Post X in 3 Reddit
 * threads"). Against the social platforms' rules, and nothing an agent should take, so search leaves it out.
 */
const ENGAGEMENT = [
  /\b(follow|like|likes|comment|comments|share|retweet|repost|upvote|engage|enage)\b.*\b(us|me|posts?|accounts?|page|profile|tweets?|article|reels?|videos?|on (x|instagram|tiktok|youtube|facebook|reddit|twitter))\b/iu,
  /\b(fully )?engage (with|on)\b/iu,
  /\bpost\b.*\bin \d+\b.*\b(threads?|subreddits?|groups?|comments?)\b/iu,
  // Two engagement verbs ("Like, Share & Follow"), or a follow aimed at a handle.
  /\b(like|share|follow|comment|retweet|repost|subscribe)\b.*\b(like|share|follow|comment|retweet|repost|subscribe)\b/iu,
  /\bfollow\b.*@\w+/iu,
];

export function isPaidEngagement(title: string): boolean {
  return ENGAGEMENT.some((re) => re.test(title));
}

export function bountyToJob(b: Rec): NativeJob | null {
  const id = str(b.id);
  const title = str(b.title);
  if (!id || !BOUNTY_ID.test(id) || !title) return null;
  const currency = upper(b.currency);
  const net = num(b.net_reward_amount);
  const gross = num(b.gross_reward_amount);
  const amount = net ?? gross;
  const goal = str(b.business_goal_type);
  const capture = isCapture(b);
  const needs = capture ? captureNeeds(b) : [];
  const footage = num(b.min_total_verified_duration_seconds);
  const unit = capture && footage ? `per accepted submission of ${duration(footage)} verified footage` : "per accepted submission";
  const fees = net !== undefined && gross !== undefined && gross > net ? ` after fees (${money(gross)} ${currency} gross)` : "";
  const codes = strings(b.allowed_country_codes).map((c) => c.toUpperCase());
  const places = codes.map(countryName);
  const spots = num(b.spots_remaining);
  const slots = num(b.accepted_submissions_limit);
  const perUser = num(b.accepted_submissions_per_user_limit) ?? 1;
  const status = str(b.status) ?? "open";
  const host = rec(b.hosting_account);
  const poster = rec(b.poster);
  const org = str(host?.title) ?? str(rec(b.funding_account)?.title) ?? str(poster?.name) ?? str(poster?.username);
  const route = str(host?.route);
  const description = str(b.description);
  const types = strings(b.accepted_deliverable_types);
  const posted = iso(b.created_at);
  const goalTag = goal ? GOAL_TAGS[goal] : undefined;
  return {
    id,
    kind: "task",
    title,
    ...(org ? { org } : {}),
    location: {
      text: codes.length ? `Open to residents of ${places.join(", ")}` : "Worldwide",
      ...(codes.length === 1 ? { country: codes[0] } : {}),
      remote: goal !== "local_activation",
    },
    ...(amount !== undefined
      ? { pay: { min: amount, max: amount, currency, period: "unit" as const, unit, text: `${money(amount)} ${currency} ${unit}${fees}` } }
      : {}),
    ...(description ? { summary: stripHtml(description, 300), description: stripHtml(description, 6000) } : {}),
    ...(route ? { url: `https://whop.com/${route}` } : {}),
    ...(posted ? { posted_at: posted } : {}),
    tags: [
      ...(goalTag ? [goalTag] : []),
      ...(types.includes("content_url") ? ["links"] : []),
      ...(types.includes("media") ? ["files"] : []),
      ...(spots !== undefined && slots !== undefined ? [`${spots} of ${slots} spots left`] : []),
      "source:whop-bounties",
    ],
    ...(status === "open" ? { participation_mode: "direct_apply" as const } : { stages: ["search", "get"] }),
    apply_hint: capture
      ? "apply claims an attempt; record the clips in the Whop app, then submit once the footage is in."
      : "No claim step: post the work, then submit with the links in note, or upload files first. The submission goes straight to review.",
    requirements: {
      ...(needs.length
        ? {
            questions: [...new Set<string>([...CAPTURE_FIELDS, ...needs])].map((id) => ({
              id,
              question: CAPTURE_QUESTIONS[id] ?? id,
              type: "text" as const,
              required: needs.includes(id),
            })),
          }
        : {}),
      how_to: capture
        ? [
            "apply claims an attempt.",
            "Record the clips in the Whop app; they collect on the attempt.",
            `submit once ${footage ? duration(footage) : "the required time"} of verified footage is in.`,
          ]
        : [
            "Do the work and post it where the bounty asks.",
            `submit with the links in note (up to ${MAX_LINKS}), or upload files first (up to ${MAX_FILES}).`,
            "The submission goes straight to the poster's review on Whop.",
          ],
      rules: [
        ...(codes.length ? [`Open to residents of ${places.join(", ")}`] : []),
        perUser > 1 ? `Up to ${perUser} winning submissions per person, one attempt at a time` : "One winning submission per person",
      ],
    },
    raw: {
      status,
      business_goal_type: goal ?? null,
      gross_reward_amount: gross ?? null,
      net_reward_amount: net ?? null,
      currency: currency.toLowerCase(),
      spots_remaining: spots ?? null,
      accepted_submissions_limit: slots ?? null,
      accepted_submissions_per_user_limit: perUser,
      viewer_accepted_submissions_count: num(b.viewer_accepted_submissions_count) ?? 0,
      accepted_deliverable_types: types,
      allowed_country_codes: codes,
      min_total_verified_duration_seconds: footage ?? null,
      experience_id: str(b.experience_id) ?? null,
      discussion_post_id: str(b.discussion_post_id) ?? null,
    },
  };
}

const SUBMISSION_STAGE: Record<string, NativeApplication["stage"]> = {
  in_progress: "work_needed",
  submitted: "in_review",
  approved: "accepted",
  denied: "rejected",
};

const isActive = (s: Rec | undefined) => str(s?.status) === "in_progress" || str(s?.status) === "submitted";

/** One bounty submission as an application, with its bounty when known (title, reward, footage target). */
export function submissionToApplication(s: Rec, bounty?: Rec): NativeApplication {
  const id = str(s.id) ?? "";
  const status = str(s.status);
  const stage = (status && SUBMISSION_STAGE[status]) || "closed";
  const capture = str(s.deliverable_type) === "data_capture" || isCapture(bounty);
  const pay = reward(bounty);
  const paid = pay ? `${money(pay.amount)} ${pay.currency}` : "the reward";
  const seconds = num(s.captured_duration_seconds) ?? 0;
  const wanted = num(bounty?.min_total_verified_duration_seconds);
  const reason = str(s.denial_reason);
  const next =
    stage === "work_needed"
      ? capture
        ? `Record the clips in the Whop app: ${duration(seconds)}${wanted ? ` of ${duration(wanted)}` : ""} verified so far. Call submit once the footage is in.`
        : "The attempt is open: finish the proof in the Whop app, then call submit (links in note attach to it)."
      : stage === "in_review"
        ? `Waiting for the poster's review on Whop. Approval pays ${paid} into your Whop balance.`
        : stage === "accepted"
          ? `Approved: ${paid} goes to your Whop balance. See earnings to pay it out.`
          : stage === "rejected"
            ? `Denied${reason ? `: ${reason}` : "."}`
            : "The attempt ended without proof.";
  const fileRows = recs(s.files);
  const fileUrls = new Set(fileRows.map((f) => str(f.url)).filter((u): u is string => Boolean(u)));
  const files: ApplicationFile[] = [
    ...strings(s.deliverable_urls)
      .filter((u) => !fileUrls.has(u))
      .map((u) => ({ id: u, name: u, kind: "link" })),
    ...fileRows.map((f) => {
      const fileId = str(f.id) ?? "file";
      return { id: fileId, name: str(f.filename) ?? fileId, kind: str(f.content_type) ?? str(f.attachment_type) ?? "file" };
    }),
  ];
  const title = str(bounty?.title);
  const created = iso(s.created_at);
  const updated = iso(s.updated_at);
  const review =
    stage === "accepted" && pay ? { review: { earned: pay } } : stage === "rejected" && reason ? { review: { note: reason } } : {};
  return {
    id,
    job_id: str(s.bounty_id) ?? str(bounty?.id) ?? id,
    ...(title ? { job_title: title } : {}),
    stage,
    ...(files.length ? { files } : {}),
    ...(capture && wanted
      ? { progress: { received: Math.floor(seconds / 60), wanted: Math.ceil(wanted / 60), ready_to_submit: seconds >= wanted } }
      : {}),
    next,
    ...(created ? { created_at: created } : {}),
    ...(updated ? { updated_at: updated } : {}),
    ...review,
    raw: {
      status: status ?? null,
      deliverable_type: str(s.deliverable_type) ?? null,
      claimed_at: str(s.claimed_at) ?? null,
      submitted_at: str(s.submitted_at) ?? null,
      resolved_at: str(s.resolved_at) ?? null,
      captured_clip_count: num(s.captured_clip_count) ?? 0,
      captured_duration_seconds: seconds,
    },
  };
}

const PAYOUT_STATUS: Record<string, NativePayout["status"]> = {
  requested: "requested",
  in_review: "requested",
  processing: "requested",
  completed: "paid",
  reversed: "rejected",
  failed: "rejected",
  denied: "rejected",
  canceled: "cancelled",
};

/** One Whop payout (`wdrl_`) in the protocol's shape. */
export function payoutToNative(p: Rec, fallbackMethod = "whop"): NativePayout {
  const method = rec(p.payout_method);
  const supported = rec(method?.supported_payout_method);
  const requested = iso(p.created_at);
  const note = str(p.notes);
  return {
    id: str(p.id) ?? "payout",
    amount: { amount: num(p.amount) ?? 0, currency: upper(p.currency) },
    method: str(method?.nickname) ?? str(supported?.payer_name) ?? str(supported?.name) ?? str(supported?.delivery_type) ?? fallbackMethod,
    status: PAYOUT_STATUS[str(p.status) ?? ""] ?? "requested",
    ...(requested ? { requested_at: requested } : {}),
    ...(note ? { note } : {}),
    raw: {
      status: str(p.status) ?? null,
      net_amount: p.net_amount ?? null,
      fee_amount: p.fee_amount ?? null,
      speed: p.speed ?? null,
      estimated_arrival: p.estimated_arrival ?? null,
    },
  };
}

function methodLabel(m: Rec): string {
  const id = str(m.id) ?? "?";
  const supported = rec(m.supported_payout_method);
  const name = str(m.nickname) ?? str(supported?.name) ?? str(m.payer_name) ?? str(m.institution_name) ?? str(supported?.delivery_type);
  return `${id}${name ? ` (${name}${m.is_default === true ? ", default" : ""})` : m.is_default === true ? " (default)" : ""}`;
}

// ---- the work waiting to be submitted ----------------------------------------

type DraftFile = { id: string; name: string; kind: string; size?: number };
type Draft = {
  bounty_id: string;
  title?: string;
  urls: string[];
  files: DraftFile[];
  caption?: string;
  affiliate_code?: string;
  at: string;
};

function draftsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = stateDir(env);
  return path.join(base, "whop-bounties-drafts.json");
}

/** Links and files added to a bounty before submit, kept on disk so a later process can submit them. */
class Drafts {
  private memory: Record<string, Draft> | undefined;

  constructor(private readonly file: string = draftsPath()) {}

  private load(): Record<string, Draft> {
    if (this.memory) return this.memory;
    try {
      this.memory = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Draft>;
    } catch {
      this.memory = {};
    }
    return this.memory;
  }

  get(key: string): Draft | undefined {
    return this.load()[key];
  }

  keys(): string[] {
    return Object.keys(this.load());
  }

  set(key: string, draft: Draft | undefined): void {
    const all = this.load();
    if (draft) all[key] = draft;
    else delete all[key];
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(all, null, 2));
    } catch {
      // memory still holds it for this process
    }
  }
}

function linksIn(text: string): string[] {
  return [...new Set((text.match(LINK) ?? []).map((u) => u.replace(/[),.;!?]+$/u, "")))];
}

function withoutLinks(text: string): string {
  return text.replace(LINK, " ").replace(/\s+/gu, " ").trim();
}

function draftFiles(d: Draft): ApplicationFile[] {
  return [
    ...d.urls.map((u) => ({ id: u, name: u, kind: "link" })),
    ...d.files.map((f) => ({ id: f.id, name: f.name, kind: f.kind, ...(f.size !== undefined ? { size: f.size } : {}) })),
    ...(d.caption ? [{ id: "caption", name: truncate(d.caption, 80), kind: "text" }] : []),
  ];
}

function draftNext(d: Draft): string {
  return d.urls.length + d.files.length > 0
    ? `Ready to submit ${plural(d.urls.length, "link")} and ${plural(d.files.length, "file")}: submit sends them to the poster's review on Whop.`
    : `Post the work, then submit with the links in note (up to ${MAX_LINKS}), or upload files first (up to ${MAX_FILES}). The submission goes straight to the poster's review on Whop.`;
}

function draftProgress(d: Draft) {
  const n = d.urls.length + d.files.length;
  return { received: n, wanted: 1, ready_to_submit: n > 0 };
}

function draftApplication(key: string, d: Draft): NativeApplication {
  const files = draftFiles(d);
  return {
    id: key,
    job_id: d.bounty_id,
    ...(d.title ? { job_title: d.title } : {}),
    stage: "work_needed",
    ...(files.length ? { files } : {}),
    progress: draftProgress(d),
    next: draftNext(d),
    created_at: d.at,
    raw: { draft: true },
  };
}

function receipt(d: Draft, file?: ApplicationFile): WorkReceipt {
  return { ...(file ? { file } : {}), files: draftFiles(d), progress: draftProgress(d), next: draftNext(d) };
}

function answer(input: ApplyInput, key: string): string | undefined {
  const value = input.answers?.[key];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || undefined;
}

/** The claim's capture metadata, whole or left out, since it cannot be added once the attempt exists. */
function captureMetadata(input: ApplyInput, b: Rec): Rec | undefined {
  const out: Rec = {};
  for (const field of new Set<string>([...CAPTURE_FIELDS, ...listedFields(b)])) {
    const value = answer(input, field);
    if (value !== undefined) out[field] = value;
  }
  const given = Object.keys(out).length > 0;
  const missing = captureNeeds(b, given).filter((f) => out[f] === undefined);
  if (missing.length) {
    throw new ProtocolError(
      "invalid_input",
      `The claim needs complete capture metadata, which cannot be added later: answer ${missing.join(", ")}.`,
      {
        connector: ID,
        details: { missing },
      },
    );
  }
  if (out.fov !== undefined) {
    if (!/^\d+$/u.test(String(out.fov))) {
      throw new ProtocolError(
        "invalid_input",
        `fov is the horizontal field of view in whole degrees, such as 120; ${JSON.stringify(out.fov)} is not.`,
        {
          connector: ID,
        },
      );
    }
    out.fov = Number(out.fov);
  }
  return given ? out : undefined;
}

// ---- HTTP ---------------------------------------------------------------------

type Call = { method?: "GET" | "POST" | "DELETE"; token?: string | undefined; body?: unknown; label: string };

/** One request to the Whop API, with its `{ error: { type, message } }` failures turned into ProtocolErrors. */
async function whop<T = Rec>(ctx: ConnectorContext, target: string | URL, call: Call): Promise<T> {
  const url = typeof target === "string" && target.startsWith("/") ? `${WHOP_API}${target}` : String(target);
  const method = call.method ?? (call.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
    "api-version-date": WHOP_API_VERSION,
    ...(call.token ? { authorization: `Bearer ${call.token}` } : {}),
    ...(call.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
  };
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method,
      headers,
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      signal: ctx.signal,
    });
  } catch (error) {
    throw toProtocolError(error, ID);
  }
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (response.ok) {
    if (body === undefined && text)
      throw new ProtocolError("upstream_error", `${LABEL} did not answer ${call.label} with JSON.`, { connector: ID });
    return (body ?? {}) as T;
  }
  const error = rec(rec(body)?.error);
  const message = str(error?.message) ?? (text.trim().slice(0, 300) || `HTTP ${response.status}`);
  const type = str(error?.type) ?? str(error?.code);
  const details = { status: response.status, ...(type ? { type } : {}) };
  if (response.status === 401 || response.status === 403) {
    const lead = call.token ? `${LABEL} refused the token for ${call.label} (${message}).` : `${LABEL} needs a sign-in for ${call.label}.`;
    throw new ProtocolError("auth_required", `${lead} ${WHOP_HELP}`, { connector: ID, details });
  }
  if (response.status === 404) throw new ProtocolError("not_found", `${LABEL}: ${message}`, { connector: ID, details });
  if (response.status === 409) throw new ProtocolError("already_exists", `${LABEL}: ${message}`, { connector: ID, details });
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    throw new ProtocolError("rate_limited", `${LABEL} is rate limiting requests.`, {
      connector: ID,
      retry_after: Number.isFinite(retry) && retry > 0 ? retry : 60,
      details,
    });
  }
  throw new ProtocolError(
    response.status >= 500 ? "upstream_error" : "invalid_input",
    `${LABEL} answered ${call.label} with ${response.status}: ${message}`,
    {
      connector: ID,
      details,
    },
  );
}

function requireToken(ctx: ConnectorContext): string {
  const token = ctx.credentials[TOKEN_ENV];
  if (!token) throw new ProtocolError("auth_required", WHOP_HELP, { connector: ID });
  return token;
}

// ---- the connector --------------------------------------------------------------

export type WhopBountiesOptions = {
  /** Where links and files wait for submit. Default: whop-bounties-drafts.json in WORK_CACHE_DIR or ~/.cache/work-protocol. */
  draftsFile?: string;
};

export function createWhopBounties(options: WhopBountiesOptions = {}) {
  const drafts = perTenant(() => new Drafts(options.draftsFile));
  const selves = new Map<string, Rec>();

  async function me(ctx: ConnectorContext, token: string): Promise<Rec> {
    const cached = selves.get(token);
    if (cached) return cached;
    const user = await whop<Rec>(ctx, "/users/me?include_balance=false", { token, label: "your account" });
    if (!str(user.id)) throw new ProtocolError("upstream_error", `${LABEL} answered /users/me without an id.`, { connector: ID });
    selves.set(token, user);
    return user;
  }

  const bounty = (ctx: ConnectorContext, id: string, token?: string) =>
    whop<Rec>(ctx, `/bounties/${encodeURIComponent(id)}`, { token, label: `bounty ${id}` });

  async function bountyOrNothing(ctx: ConnectorContext, id: string | undefined, token: string): Promise<Rec | undefined> {
    if (!id || !BOUNTY_ID.test(id)) return undefined;
    try {
      return await bounty(ctx, id, token);
    } catch {
      return undefined;
    }
  }

  /** The person's own submissions, newest first. */
  async function mine(ctx: ConnectorContext, token: string, filter: { bounty_id?: string; status?: string } = {}): Promise<Rec[]> {
    const self = str((await me(ctx, token)).id);
    const url = new URL(`${WHOP_API}/bounty_submissions`);
    if (filter.bounty_id) url.searchParams.set("bounty_id", filter.bounty_id);
    if (filter.status) url.searchParams.set("status", filter.status);
    url.searchParams.set("first", "100");
    const body = await whop<Rec>(ctx, url, { token, label: "your submissions" });
    return recs(body.data).filter((s) => {
      const worker = str(rec(s.worker)?.id);
      return !worker || worker === self;
    });
  }

  /** The bounties the person took part in, by id: titles and rewards for their submissions. */
  async function participated(ctx: ConnectorContext, token: string): Promise<Map<string, Rec>> {
    const self = str((await me(ctx, token)).id);
    const url = new URL(`${WHOP_API}/bounties`);
    if (self) url.searchParams.set("user_id", self);
    url.searchParams.set("first", "100");
    const out = new Map<string, Rec>();
    try {
      const body = await whop<Rec>(ctx, url, { token, label: "your bounties" });
      for (const b of recs(body.data)) {
        const id = str(b.id);
        if (id) out.set(id, b);
      }
    } catch {
      // titles and rewards are extras; the submissions still list
    }
    return out;
  }

  async function submissionById(ctx: ConnectorContext, id: string, token: string): Promise<Rec> {
    return whop<Rec>(ctx, `/bounty_submissions/${encodeURIComponent(id)}`, { token, label: `submission ${id}` });
  }

  async function withBounty(ctx: ConnectorContext, s: Rec, token: string, known?: Rec): Promise<NativeApplication> {
    return submissionToApplication(s, known ?? (await bountyOrNothing(ctx, str(s.bounty_id), token)));
  }

  /** A new draft for upload without apply: a standard bounty, or an open attempt (livestream proof takes links and files on submit). */
  async function startDraft(ctx: ConnectorContext, key: string, token: string): Promise<Draft> {
    const at = new Date().toISOString();
    if (BOUNTY_ID.test(key)) {
      const b = await bounty(ctx, key, token);
      if (isCapture(b)) {
        throw new ProtocolError(
          "invalid_input",
          "Data-capture proof is recorded in the Whop app, not uploaded: apply, record, then submit.",
          {
            connector: ID,
          },
        );
      }
      const status = str(b.status) ?? "open";
      if (status !== "open") {
        throw new ProtocolError("wrong_stage", `This bounty is ${status} and takes no new submissions.`, {
          connector: ID,
          details: { stage: status },
        });
      }
      const title = str(b.title);
      return { bounty_id: key, ...(title ? { title } : {}), urls: [], files: [], at };
    }
    if (SUBMISSION_ID.test(key)) {
      const s = await submissionById(ctx, key, token);
      const b = await bountyOrNothing(ctx, str(s.bounty_id), token);
      if (str(s.deliverable_type) === "data_capture" || isCapture(b)) {
        throw new ProtocolError("invalid_input", "Data-capture proof is recorded in the Whop app, not uploaded: record, then submit.", {
          connector: ID,
        });
      }
      const title = str(b?.title);
      return { bounty_id: str(s.bounty_id) ?? key, ...(title ? { title } : {}), urls: [], files: [], at };
    }
    throw new ProtocolError("not_found", `${JSON.stringify(key)} is not a Whop bounty (bnty_) or attempt (btys_) id.`, { connector: ID });
  }

  return defineConnector({
    id: ID,
    name: "Whop bounties",
    description:
      "Paid clipping, UGC, post-engagement and data-capture bounties on Whop, each reward held in escrow and paid per accepted submission. Find bounties, submit links or files, follow reviews, read your balance and pay out, with a Whop OAuth token.",
    homepage: "https://whop.com",
    kinds: ["task"],
    category: "micro_task",
    tier: "self",
    payoutRails: ["fiat"],
    auth: { type: "api_key", env: [TOKEN_ENV], help: WHOP_HELP, required: true },

    async search(query, ctx) {
      const token = requireToken(ctx);
      const limit = query.limit ?? 20;
      const words = query.query?.trim();
      const byId = words && BOUNTY_ID.test(words) ? words : undefined;
      const country = countryCode(query.location);
      const url = new URL(`${WHOP_API}/bounties`);
      url.searchParams.set("status", "open");
      if (byId) url.searchParams.set("query", byId);
      if (country) url.searchParams.set("country", country);
      // A full page: paid engagement is filtered out here, and words are matched here too.
      url.searchParams.set("first", "100");
      const body = await whop<Rec>(ctx, url, { token, label: "bounties" });
      const jobs = recs(body.data)
        .map(bountyToJob)
        .filter((j): j is NativeJob => j !== null && !isPaidEngagement(j.title));
      const filtered = applyFilters(jobs, query, { query: Boolean(byId), location: Boolean(country) });
      return { jobs: filtered.slice(0, limit), more: rec(body.page_info)?.has_next_page === true || filtered.length > limit };
    },

    async get(nativeId, ctx) {
      if (!BOUNTY_ID.test(nativeId)) return null;
      const token = ctx.credentials[TOKEN_ENV];
      try {
        return bountyToJob(await bounty(ctx, nativeId, token));
      } catch (error) {
        // An expired token should not hide a public bounty.
        if (token && error instanceof ProtocolError && error.code === "auth_required") return bountyToJob(await bounty(ctx, nativeId));
        throw error;
      }
    },

    async apply(nativeId, input, ctx) {
      const token = requireToken(ctx);
      if (!BOUNTY_ID.test(nativeId)) {
        throw new ProtocolError("not_found", `Whop bounty ids start with bnty_; ${JSON.stringify(nativeId)} is not one.`, {
          connector: ID,
        });
      }
      const b = await bounty(ctx, nativeId, token);
      const current = (await mine(ctx, token, { bounty_id: nativeId }))[0];
      if (current && isActive(current)) return submissionToApplication(current, b);
      const status = str(b.status) ?? "open";
      if (status !== "open") {
        throw new ProtocolError("wrong_stage", `This bounty is ${status} and takes no new submissions.`, {
          connector: ID,
          details: { stage: status },
        });
      }
      const won = num(b.viewer_accepted_submissions_count) ?? 0;
      const perUser = num(b.accepted_submissions_per_user_limit) ?? 1;
      if (won >= perUser) {
        throw new ProtocolError("wrong_stage", `You already won ${plural(won, "slot")} here, the most one person can on this bounty.`, {
          connector: ID,
          details: { stage: "accepted" },
        });
      }
      const affiliate = answer(input, "affiliate_code");
      if (isCapture(b)) {
        const metadata = captureMetadata(input, b);
        const body: Rec = { bounty_id: nativeId, ...(affiliate ? { affiliate_code: affiliate } : {}), ...(metadata ? { metadata } : {}) };
        try {
          return submissionToApplication(await whop<Rec>(ctx, "/bounty_submissions", { token, body, label: "the claim" }), b);
        } catch (error) {
          if (error instanceof ProtocolError && error.code === "already_exists") {
            const again = (await mine(ctx, token, { bounty_id: nativeId }))[0];
            if (again) return submissionToApplication(again, b);
          }
          throw error;
        }
      }
      const draft: Draft = drafts().get(nativeId) ?? { bounty_id: nativeId, urls: [], files: [], at: new Date().toISOString() };
      draft.title = str(b.title) ?? draft.title;
      if (affiliate) draft.affiliate_code = affiliate;
      for (const link of linksIn(input.note ?? "")) if (!draft.urls.includes(link) && draft.urls.length < MAX_LINKS) draft.urls.push(link);
      drafts().set(nativeId, draft);
      return draftApplication(nativeId, draft);
    },

    async upload(nativeApplicationId, work, ctx) {
      const token = requireToken(ctx);
      const key = nativeApplicationId;
      const draft: Draft = drafts().get(key) ?? (await startDraft(ctx, key, token));
      let file: ApplicationFile;
      if (work.kind === "text") {
        const links = linksIn(work.text);
        const rest = withoutLinks(work.text);
        const fresh = links.filter((u) => !draft.urls.includes(u));
        const firstFresh = fresh[0];
        const firstLink = links[0];
        if (firstLink && !firstFresh && !rest) {
          throw new ProtocolError("already_exists", "That link is already attached.", {
            connector: ID,
            details: { file: { id: firstLink, name: firstLink, kind: "link" } },
          });
        }
        if (draft.urls.length + fresh.length > MAX_LINKS) {
          throw new ProtocolError("invalid_input", `A submission takes up to ${MAX_LINKS} links.`, { connector: ID });
        }
        draft.urls.push(...fresh);
        if (rest) draft.caption = rest;
        const shown = firstFresh ?? firstLink;
        file = shown ? { id: shown, name: shown, kind: "link" } : { id: "caption", name: truncate(rest, 80), kind: "text" };
      } else {
        const same = draft.files.find((f) => f.name === work.name && f.size === work.bytes.byteLength);
        if (same)
          throw new ProtocolError("already_exists", `${work.name} is already attached.`, { connector: ID, details: { file: same } });
        if (draft.files.length >= MAX_FILES) {
          throw new ProtocolError("invalid_input", `A submission takes up to ${MAX_FILES} files.`, { connector: ID });
        }
        const created = await whop<Rec>(ctx, "/files", { token, body: { filename: work.name }, label: "the file" });
        const fileId = str(created.id);
        const uploadUrl = str(created.upload_url);
        if (!fileId || !uploadUrl) {
          throw new ProtocolError("upstream_error", `${LABEL} answered the file request without an id and an upload url.`, {
            connector: ID,
          });
        }
        const uploadHeaders = Object.fromEntries(
          Object.entries(rec(created.upload_headers) ?? {}).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as const] : [])),
        );
        let put: Response;
        try {
          put = await ctx.fetch(uploadUrl, { method: "PUT", headers: uploadHeaders, body: work.bytes, signal: ctx.signal });
        } catch (error) {
          throw toProtocolError(error, ID);
        }
        if (!put.ok) {
          throw new ProtocolError("upstream_error", `${LABEL}'s file storage answered ${put.status} to the upload.`, {
            connector: ID,
            details: { status: put.status },
          });
        }
        const entry: DraftFile = { id: fileId, name: work.name, kind: work.mime_type, size: work.bytes.byteLength };
        draft.files.push(entry);
        file = entry;
      }
      drafts().set(key, draft);
      return receipt(draft, file);
    },

    async remove(nativeApplicationId, fileId, _ctx) {
      const draft = drafts().get(nativeApplicationId);
      if (!draft) throw new ProtocolError("not_found", "Nothing is waiting to be submitted here.", { connector: ID });
      let removed: { id: string; name: string } | undefined;
      if (fileId === "caption" && draft.caption) {
        removed = { id: "caption", name: truncate(draft.caption, 80) };
        delete draft.caption;
      } else if (draft.urls.includes(fileId)) {
        removed = { id: fileId, name: fileId };
        draft.urls = draft.urls.filter((u) => u !== fileId);
      } else {
        const index = draft.files.findIndex((f) => f.id === fileId);
        if (index < 0) throw new ProtocolError("not_found", `${JSON.stringify(fileId)} is not attached.`, { connector: ID });
        const [gone] = draft.files.splice(index, 1);
        removed = { id: gone!.id, name: gone!.name };
      }
      drafts().set(nativeApplicationId, draft);
      return { removed, ...receipt(draft) };
    },

    async submit(nativeApplicationId, input, ctx) {
      const token = requireToken(ctx);
      const key = nativeApplicationId;
      const draft = drafts().get(key);
      const note = input.note ?? "";
      const urls = [...new Set([...(draft?.urls ?? []), ...linksIn(note)])];
      const fileIds = (draft?.files ?? []).map((f) => f.id);
      const caption = withoutLinks(note) || draft?.caption;
      if (urls.length > MAX_LINKS)
        throw new ProtocolError("invalid_input", `A submission takes up to ${MAX_LINKS} links.`, { connector: ID });
      const deliverable =
        urls.length || fileIds.length || caption
          ? { ...(urls.length ? { urls } : {}), ...(fileIds.length ? { file_ids: fileIds } : {}), ...(caption ? { caption } : {}) }
          : undefined;

      if (BOUNTY_ID.test(key)) {
        if (!urls.length && !fileIds.length) {
          const current = (await mine(ctx, token, { bounty_id: key }))[0];
          if (current && isActive(current)) return withBounty(ctx, current, token);
          throw new ProtocolError(
            "not_ready",
            `Add the work first: links to the posted work in note (up to ${MAX_LINKS}), or files with upload (up to ${MAX_FILES}).`,
            { connector: ID },
          );
        }
        const body: Rec = { bounty_id: key, deliverable, ...(draft?.affiliate_code ? { affiliate_code: draft.affiliate_code } : {}) };
        let created: Rec;
        try {
          created = await whop<Rec>(ctx, "/bounty_submissions", { token, body, label: "the submission" });
        } catch (error) {
          if (error instanceof ProtocolError && error.code === "already_exists") {
            const current = (await mine(ctx, token, { bounty_id: key }))[0];
            if (current) return withBounty(ctx, current, token);
          }
          throw error;
        }
        drafts().set(key, undefined);
        return withBounty(ctx, created, token);
      }

      if (SUBMISSION_ID.test(key)) {
        const attempt = await submissionById(ctx, key, token);
        const b = await bountyOrNothing(ctx, str(attempt.bounty_id), token);
        if (str(attempt.status) !== "in_progress") return submissionToApplication(attempt, b);
        // A data-capture attempt takes no payload; a livestream attempt can carry links and files.
        const capture = str(attempt.deliverable_type) === "data_capture" || isCapture(b);
        let done: Rec;
        try {
          done = await whop<Rec>(ctx, `/bounty_submissions/${encodeURIComponent(key)}/submit`, {
            token,
            method: "POST",
            ...(deliverable && !capture ? { body: { deliverable } } : {}),
            label: "the attempt",
          });
        } catch (error) {
          if (error instanceof ProtocolError && error.code === "already_exists")
            return withBounty(ctx, await submissionById(ctx, key, token), token, b);
          if (error instanceof ProtocolError && error.code === "invalid_input") {
            throw new ProtocolError("not_ready", error.message, { connector: ID, details: error.details });
          }
          throw error;
        }
        drafts().set(key, undefined);
        return submissionToApplication(done, b);
      }

      throw new ProtocolError("not_found", `${JSON.stringify(key)} is not a Whop bounty (bnty_) or attempt (btys_) id.`, { connector: ID });
    },

    async status(nativeApplicationId, ctx) {
      const token = requireToken(ctx);
      const key = nativeApplicationId;
      if (SUBMISSION_ID.test(key)) return withBounty(ctx, await submissionById(ctx, key, token), token);
      if (!BOUNTY_ID.test(key)) return null;
      const current = (await mine(ctx, token, { bounty_id: key }))[0];
      const draft = drafts().get(key);
      if (current && (isActive(current) || !draft)) return withBounty(ctx, current, token);
      return draft ? draftApplication(key, draft) : null;
    },

    async list(ctx) {
      const token = requireToken(ctx);
      await me(ctx, token);
      const [rows, bounties] = await Promise.all([mine(ctx, token), participated(ctx, token)]);
      const apps = rows.map((s) => submissionToApplication(s, bounties.get(str(s.bounty_id) ?? "")));
      for (const key of drafts().keys()) {
        const draft = drafts().get(key);
        if (draft && BOUNTY_ID.test(key)) apps.push(draftApplication(key, draft));
      }
      return apps;
    },

    async account(ctx) {
      const token = ctx.credentials[TOKEN_ENV];
      if (!token) return { signed_in: false, help: WHOP_HELP };
      const user = await me(ctx, token);
      const label = str(user.username) ?? str(user.name);
      return {
        signed_in: true,
        ...(label ? { label } : {}),
        ready: true,
        profile: { id: user.id, username: user.username ?? null, name: user.name ?? null },
      };
    },

    async earnings(ctx) {
      const token = requireToken(ctx);
      const user = await whop<Rec>(ctx, "/users/me", { token, label: "your balance" });
      const self = str(user.id);
      if (self) selves.set(token, user);
      const balance = rec(user.balance);
      const available = recs(balance?.cash).reduce((sum, c) => sum + (num(c.balance_usd) ?? 0), 0);
      const pending = num(balance?.pending_usd);
      const lifetime = num(rec(rec(user.earnings_usd)?.personal)?.lifetime);
      const forUser = (route: string) => {
        const url = new URL(`${WHOP_API}${route}`);
        if (self) url.searchParams.set("user_id", self);
        url.searchParams.set("first", "20");
        return url;
      };
      const [payouts, methods, approved, bounties] = await Promise.allSettled([
        whop<Rec>(ctx, forUser("/payouts"), { token, label: "your payouts" }),
        whop<Rec>(ctx, forUser("/payouts/methods"), { token, label: "your payout methods" }),
        mine(ctx, token, { status: "approved" }),
        participated(ctx, token),
      ]);
      const known = bounties.status === "fulfilled" ? bounties.value : new Map<string, Rec>();
      const entries: Earning[] =
        approved.status === "fulfilled"
          ? approved.value.flatMap((s) => {
              const id = str(s.id);
              const b = known.get(str(s.bounty_id) ?? "");
              const pay = reward(b);
              if (!id || !pay) return [];
              const earned = iso(s.resolved_at);
              const title = str(b?.title);
              return [
                {
                  id,
                  application_id: id,
                  ...(title ? { job_title: title } : {}),
                  amount: pay.amount,
                  currency: pay.currency,
                  status: "available" as const,
                  ...(earned ? { earned_at: earned } : {}),
                  note: "The bounty's quoted reward after fees.",
                },
              ];
            })
          : [];
      const out: NativeEarnings = {
        balance: { amount: round2(available), currency: "USD" },
        ...(lifetime !== undefined ? { total_earned: { amount: lifetime, currency: "USD" } } : {}),
        ...(pending ? { pending: { amount: pending, currency: "USD" } } : {}),
        ...(entries.length ? { entries } : {}),
        ...(payouts.status === "fulfilled" ? { payouts: recs(payouts.value.data).map((p) => payoutToNative(p)) } : {}),
        ...(methods.status === "fulfilled" ? { methods: recs(methods.value.data).map(methodLabel) } : {}),
        help: "Approved bounty rewards land in your Whop balance. Pay out with method set to a saved payout method's id, default, or a word from its name; add a method in your Whop payout settings.",
      };
      return out;
    },

    async payout(input, ctx) {
      const token = requireToken(ctx);
      const user = await whop<Rec>(ctx, "/users/me", { token, label: "your balance" });
      const self = str(user.id);
      if (!self) throw new ProtocolError("upstream_error", `${LABEL} answered /users/me without an id.`, { connector: ID });
      // Always resolved against the saved methods: the docs give their ids as potk_, pyot_ and pytk_ in different places.
      const wanted = input.destination?.trim() || input.method.trim();
      const url = new URL(`${WHOP_API}/payouts/methods`);
      url.searchParams.set("user_id", self);
      url.searchParams.set("first", "100");
      const saved = recs((await whop<Rec>(ctx, url, { token, label: "your payout methods" })).data);
      if (!saved.length) {
        throw new ProtocolError("not_ready", "Add a payout method in your Whop payout settings first.", { connector: ID });
      }
      const words = wanted.toLowerCase();
      const chosen =
        saved.find((m) => str(m.id) === wanted) ??
        (words === "default" || words === "whop"
          ? (saved.find((m) => m.is_default === true) ?? saved[0])
          : saved.find((m) => {
              const supported = rec(m.supported_payout_method);
              return [m.nickname, m.institution_name, m.payer_name, supported?.name, supported?.delivery_type]
                .map((v) => str(v)?.toLowerCase() ?? "")
                .some((v) => v.includes(words));
            }));
      const methodId = str(chosen?.id);
      if (!chosen || !methodId) {
        throw new ProtocolError(
          "invalid_input",
          `No saved payout method matches ${JSON.stringify(wanted)}. Saved: ${saved.map(methodLabel).join("; ")}.`,
          {
            connector: ID,
          },
        );
      }
      const methodName = methodLabel(chosen);
      let amount = input.amount;
      let currency: string | undefined;
      if (amount === undefined) {
        const cash = recs(rec(user.balance)?.cash)
          .map((c) => ({
            currency: str(c.currency) ?? "usd",
            amount: num(c.total_withdrawable_balance) ?? 0,
            usd: num(c.balance_usd) ?? 0,
          }))
          .filter((c) => c.amount > 0)
          .sort((a, b) => (a.currency === "usd" ? -1 : b.currency === "usd" ? 1 : b.usd - a.usd));
        const first = cash[0];
        if (!first) throw new ProtocolError("not_ready", "Nothing in your Whop balance can be paid out yet.", { connector: ID });
        amount = floor2(first.amount);
        currency = first.currency;
      }
      const note = input.note?.trim();
      const body: Rec = {
        user_id: self,
        amount,
        ...(currency ? { currency } : {}),
        payout_method_id: methodId,
        // Whop caps notes at 255 characters; truncate adds an ellipsis after the cut.
        ...(note ? { notes: truncate(note, 254) } : {}),
      };
      const created = await whop<Rec>(ctx, "/payouts", { token, body, label: "the payout" });
      return payoutToNative(created, methodName);
    },
  });
}

export const whopBounties = createWhopBounties();
