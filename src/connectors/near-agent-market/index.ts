/**
 * NEAR AI Agent Market (market.near.ai) through its agent API, as one agent holding an
 * `aat_` token: the public job board, bids and competition entries, files, deliveries,
 * and where each bid and assignment stands.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConnector, type ConnectorContext } from "../../core/connector.js";
import { ProtocolError, isProtocolError, toProtocolError, type ErrorCode } from "../../core/errors.js";
import { applyFilters, iso, num, str, strings } from "../../core/jsonBoard.js";
import { stripHtml, truncate } from "../../core/text.js";
import type { ApplicationFile, ApplyInput, NativeApplication, NativeJob, Question, Stage, WorkReceipt } from "../../core/types.js";
import { USER_AGENT } from "../../core/version.js";
import { perTenant, stateDir } from "../../core/tenant.js";

export const NEAR_MARKET = "https://market.near.ai";
export const NEAR_MARKET_API = `${NEAR_MARKET}/v1`;
const ID = "near-agent-market";
const LABEL = "NEAR AI Agent Market";
const TOKEN_ENV = "NEAR_AGENT_MARKET_TOKEN";
export const NEAR_MARKET_HELP =
  "Set NEAR_AGENT_MARKET_TOKEN to an agent API token (aat_…): call connect_account with the owner's email to register an agent, or register one at https://market.near.ai/building/agents and mint its token there. Every call needs it, the job board included.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PAGE = 100;
const MAX_PAGES = 5;
const MARKDOWN_MAX = 256 * 1024;
const ENTRY_MARKDOWN_MAX = 96 * 1024;
const FILES_MAX = 5;
const FILE_BYTES_MAX = 100 * 1024 * 1024;
const SLA_MAX_SECONDS = 30 * 24 * 3600;
const PAYOUTS_PAGE = `${NEAR_MARKET}/building/payouts`;

/** Job stages for a job that no longer takes bids: someone (maybe you) works on it, or it is done. */
const ACTIVE_STAGES: Stage[] = ["get", "upload", "remove", "submit", "status", "link"];
const DONE_STAGES: Stage[] = ["get", "status", "link"];

type Rec = Record<string, unknown>;
/** One bid or assignment of the agent on a job, with the job brief when the API embedded it. */
export type Held = { assignment?: Rec; job?: Rec; latest?: Rec; autoAcceptAt?: string; bid?: Rec };
type HeldFile = { id: string; name: string; size: number; sha256: string; url?: string };
type HeldText = { id: string; text: string };
type Work = { files: HeldFile[]; texts: HeldText[] };

const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);
const recs = (value: unknown): Rec[] => (Array.isArray(value) ? value.map(rec).filter((r): r is Rec => Boolean(r)) : []);
const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;
const jobUrl = (jobId: string) => `${NEAR_MARKET}/jobs/${jobId}`;
/** Bids listed with their job read, newest first; older ones show without a title. */
const BID_JOBS_READ = 20;

/** "25.000000000000" -> "25", "12.500000000000" -> "12.5". */
function amountText(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

function money(value: number | undefined, token: string | undefined): string | undefined {
  return value === undefined ? undefined : `${amountText(value)}${token ? ` ${token}` : ""}`;
}

/** "2026-10-27T18:00:00.000Z" -> "2026-10-27 18:00 UTC". */
function day(value: string | undefined): string | undefined {
  return value ? `${value.slice(0, 16).replace("T", " ")} UTC` : undefined;
}

/** A handle the sign-up accepts: 3-30 of [a-z0-9-], starting with a letter, with a random tail so it is free. */
function handleFor(seed: string): string {
  const base = seed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .slice(0, 21)
    .replace(/-+$/u, "");
  return `${base || "agent"}-${randomBytes(4).toString("hex")}`;
}

const isCompetition = (job: Rec | undefined) => str(job?.jobKind) === "competition";

const BADGE_TAG: Record<string, string> = { verified: "needs-verified-builder", identity_verified: "needs-identity-verified-builder" };
const BADGE_TEXT: Record<string, string> = {
  verified: "a verified builder badge",
  identity_verified: "an identity-verified builder badge",
};
const KIND_TAG: Record<string, string> = { standard: "bid", instant: "instant-hire", competition: "competition" };

function bidQuestions(token: string): Question[] {
  return [
    { id: "amount", question: `Your price for the job, in ${token}`, type: "text", required: true },
    {
      id: "delivery_hours",
      question: "Hours you promise to deliver in once awarded (up to 720); your agent's default otherwise",
      type: "text",
      required: false,
    },
  ];
}

/** One job of the board or of `GET /v1/jobs/{id}` as a task. */
export function jobToNative(j: Rec): NativeJob | null {
  const id = str(j.jobId);
  const title = str(j.title);
  if (!id || !title) return null;
  const kind = str(j.jobKind) ?? "standard";
  const competition = kind === "competition";
  const status = str(j.status) ?? "open";
  const open = status === "open" || status === "filling";
  const token = str(j.budgetToken) ?? (competition ? "USDC" : "USD");
  const amount = num(j.budgetAmount);
  const closes = iso(j.entriesCloseAt);
  const badge = str(j.minBuilderVerification) ?? "none";
  const slots = num(j.maxSlots);
  const free = num(j.currentMaxSlots);
  const windowDays = num(j.acceptanceWindowDays);
  const brief = str(j.description);
  const creator = str(rec(j.creator)?.displayName);
  const posted = iso(j.createdAt);
  const pay =
    amount !== undefined && amount > 0
      ? competition
        ? {
            max: amount,
            currency: token,
            period: "unit" as const,
            unit: "prize pool, split among the best works",
            text: `${money(amount, token)} prize pool`,
          }
        : { max: amount, currency: token, period: "unit" as const, unit: "per job", text: `Budget ${money(amount, token)}` }
      : undefined;
  const needs = BADGE_TEXT[badge];
  const hint = competition
    ? `Enter with apply_to_job (free and final), then add_work and submit_work${closes ? ` before ${day(closes)}` : ""}; a judge scores the works after the deadline and the best share the pool.`
    : `Bid with apply_to_job: answers.amount (your price in ${token}), your proposal in note, optional answers.delivery_hours. When the poster awards your bid and funds escrow, add_work and submit_work.`;
  return {
    id,
    kind: "task",
    title,
    ...(creator ? { org: creator } : {}),
    location: { remote: true },
    ...(pay ? { pay } : {}),
    ...(brief ? { summary: stripHtml(brief, 300), description: stripHtml(brief, 6000) } : {}),
    url: jobUrl(id),
    ...(posted ? { posted_at: posted } : {}),
    ...(competition && closes ? { expires_at: closes } : {}),
    tags: [
      KIND_TAG[kind] ?? kind,
      ...strings(j.tags).slice(0, 3),
      ...(BADGE_TAG[badge] ? [BADGE_TAG[badge]] : []),
      ...(slots !== undefined && slots > 1 ? [`${free ?? slots} of ${slots} slots free`] : []),
      "agent-allowed",
      "source:near-agent-market",
    ],
    ...(open ? {} : { stages: status === "in_progress" ? ACTIVE_STAGES : DONE_STAGES }),
    apply_hint: needs ? `${hint} Needs ${needs} on the agent owner's account.` : hint,
    requirements: {
      ...(competition ? {} : { questions: bidQuestions(token) }),
      rules: competition
        ? [
            "One entry per builder; entering is final.",
            "The work is Markdown up to 96 KiB plus up to 5 files; only the last version before the deadline is judged.",
          ]
        : [
            "The delivery is Markdown up to 256 KiB plus up to 5 files, 100 MiB together.",
            ...(windowDays !== undefined ? [`Silence accepts a delivery ${windowDays} days after it is submitted.`] : []),
          ],
    },
    raw: {
      job_kind: kind,
      status,
      budget_token: token,
      max_slots: slots ?? null,
      free_slots: free ?? null,
      min_builder_verification: badge,
      requires_verifiable: j.requiresVerifiable === true,
      acceptance_window_days: windowDays ?? null,
    },
  };
}

function lastBuyerWords(held: Held): string {
  const latest = held.latest;
  const body = str(latest?.senderSide) === "buyer" ? str(latest?.body) : undefined;
  return body ? ` The buyer wrote: “${truncate(body.replace(/\s+/gu, " ").trim(), 300)}”` : "";
}

function assignmentState(held: Held, entry: Rec | undefined): Pick<NativeApplication, "stage" | "next" | "review"> {
  const a = held.assignment ?? {};
  const status = str(a.status) ?? "in_progress";
  const competition = isCompetition(held.job);
  const deadline = iso(a.slaDeadlineAt);
  const closes = iso(held.job?.entriesCloseAt) ?? deadline;
  const escrow = money(num(a.escrowAmount), str(a.escrowToken));
  const by = deadline ? ` by ${day(deadline)}` : "";
  const said = lastBuyerWords(held);
  const score = num(entry?.score);
  const rationale = str(entry?.rationale);
  const judged = score !== undefined ? ` Scored ${score}/100.` : "";
  const review = rationale ? { review: { note: truncate(rationale, 1000) } } : {};
  switch (status) {
    case "in_progress": {
      if (competition) {
        return {
          stage: "work_needed",
          next: `Entered. add_work and submit_work${closes ? ` before ${day(closes)}` : ""}: Markdown up to 96 KiB plus up to 5 files. You can submit again until then; the last version is judged.`,
        };
      }
      if (str(a.deliverableUrl) && !str(a.submittedAt)) {
        return {
          stage: "work_needed",
          next: `The dispute ruling sent the work back for a redo: redo it per the brief and the thread, then submit_work${by}.${said}`,
        };
      }
      if (str(a.submittedAt) && said) {
        return {
          stage: "work_needed",
          next: `The buyer asked for changes.${said} Fix the work and submit_work again${by}; a new version lists every file it keeps.`,
        };
      }
      if (!str(a.startedAt)) {
        return {
          stage: "work_needed",
          next: `Awarded${escrow ? ` (${escrow} in escrow)` : ""}. Call apply_to_job again to declare the start (until then the buyer may cancel), then add_work and submit_work${by}.${said}`,
        };
      }
      return {
        stage: "work_needed",
        next: `Awarded and started${escrow ? ` (${escrow} in escrow)` : ""}. add_work and submit_work${by}; the buyer may cancel only if that passes without a delivery.${said}`,
      };
    }
    case "submitted":
      return competition
        ? {
            stage: "in_review",
            next: `Submitted. The judge scores the works after ${day(closes) ?? "the deadline"}; you can submit again until then.`,
          }
        : {
            stage: "in_review",
            next: `Delivered; the buyer reviews it${held.autoAcceptAt ? ` and silence accepts it on ${day(held.autoAcceptAt)}` : ""}. You can submit a corrected version while it is in review.${said}`,
          };
    case "accepted":
      return competition
        ? {
            stage: "accepted",
            next: `Won a share of the pool${escrow ? `: ${escrow}` : ""}.${judged} It goes to the agent owner's account, less the platform fee; balance and withdrawals at ${PAYOUTS_PAGE}.`,
            ...review,
          }
        : {
            stage: "accepted",
            next: `Accepted. The escrow${escrow ? ` of ${escrow}` : ""} is released to the agent owner's account, less the platform fee, usually within seconds; balance and withdrawals at ${PAYOUTS_PAGE}.`,
          };
    case "disputed":
      return { stage: "in_review", next: "The buyer opened a dispute; the platform rules on it, and the thread is read-only until then." };
    case "dispute_resolved":
      return { stage: "closed", next: "The dispute ended in a split: part of the escrow was paid to the agent owner's account." };
    case "cancelled": {
      const reason = str(a.cancelReason);
      const detail = str(a.cancelDetail);
      if (reason === "not_awarded") return { stage: "rejected", next: `Judged; the work took no prize.${judged}`, ...review };
      if (reason === "deadline_missed") return { stage: "closed", next: "Nothing was submitted before the deadline." };
      if (reason === "rejected" || reason === "failed") return { stage: "withdrawn", next: "Handed back; the buyer was refunded." };
      if (reason === "agent_suspended") {
        return {
          stage: "closed",
          next: "The platform suspended the agent and refunded the buyer; new bids are refused until it lifts the suspension.",
        };
      }
      const why = detail ? `: ${detail.replace(/[.\s]+$/u, "")}` : reason ? ` (${reason.replace(/_/gu, " ")})` : "";
      return { stage: "closed", next: `Cancelled and the buyer refunded${why}.` };
    }
    default:
      return { stage: "in_review", next: `The assignment is ${status.replace(/_/gu, " ")}.` };
  }
}

/** A bid without an assignment as an application. */
export function bidToApplication(b: Rec, job?: Rec, files?: ApplicationFile[]): NativeApplication {
  const jobId = str(b.jobId) ?? str(job?.jobId) ?? "";
  const status = str(b.status) ?? "pending";
  const price = money(num(b.amount), str(job?.budgetToken));
  const stage: NativeApplication["stage"] =
    status === "accepted" ? "work_needed" : status === "rejected" ? "rejected" : status === "withdrawn" ? "withdrawn" : "applied";
  const next =
    status === "accepted"
      ? "Awarded; the assignment opens once the escrow is funded. Check get_application again in a minute."
      : status === "rejected"
        ? "The poster chose another bid."
        : status === "withdrawn"
          ? "Bid withdrawn."
          : `Bid${price ? ` of ${price}` : ""} placed. The poster awards a bid and funds escrow; get_application shows the award.`;
  const title = str(job?.title);
  const created = iso(b.createdAt);
  const updated = iso(b.updatedAt);
  return {
    id: jobId,
    job_id: jobId,
    ...(title ? { job_title: title } : {}),
    stage,
    next,
    ...(files?.length ? { files } : {}),
    url: jobUrl(jobId),
    ...(created ? { created_at: created } : {}),
    ...(updated ? { updated_at: updated } : {}),
    raw: { bid_id: str(b.bidId) ?? null, status, amount: b.amount ?? null, sla_seconds: b.slaSeconds ?? null },
  };
}

/** The agent's bid or assignment on a job as an application. Its id is the job id. */
export function toApplication(held: Held, entry?: Rec, files?: ApplicationFile[]): NativeApplication {
  const a = held.assignment;
  if (!a) return bidToApplication(held.bid ?? {}, held.job, files);
  const jobId = str(a.jobId) ?? str(held.job?.jobId) ?? "";
  const title = str(held.job?.title);
  const created = iso(a.createdAt);
  const updated = iso(a.updatedAt);
  return {
    id: jobId,
    job_id: jobId,
    ...(title ? { job_title: title } : {}),
    ...assignmentState(held, entry),
    ...(files?.length ? { files } : {}),
    url: jobUrl(jobId),
    ...(created ? { created_at: created } : {}),
    ...(updated ? { updated_at: updated } : {}),
    raw: {
      assignment_id: str(a.assignmentId) ?? null,
      bid_id: str(a.bidId) ?? null,
      status: str(a.status) ?? null,
      escrow_amount: a.escrowAmount ?? null,
      escrow_token: str(a.escrowToken) ?? null,
      sla_deadline_at: iso(a.slaDeadlineAt) ?? null,
      started_at: iso(a.startedAt) ?? null,
      submitted_at: iso(a.submittedAt) ?? null,
      auto_accept_at: held.autoAcceptAt ?? null,
      cancel_reason: str(a.cancelReason) ?? null,
      ...(entry ? { score: num(entry.score) ?? null, prize_amount: entry.prizeAmount ?? null } : {}),
    },
  };
}

const PLATFORM_CODES: Record<string, ErrorCode> = {
  duplicate_bid: "already_exists",
  already_entered: "already_exists",
  cluster_already_in_job: "already_exists",
  builder_verification_required: "not_ready",
  usd_not_accepted: "not_ready",
  agent_paused: "not_ready",
  agent_suspended: "not_ready",
  upload_incomplete: "not_ready",
  competition_closed: "wrong_stage",
  invalid_state_transition: "wrong_stage",
  bid_thread_closed: "wrong_stage",
  competition_entry: "wrong_stage",
  file_bound: "wrong_stage",
  upload_not_pending: "wrong_stage",
};

/** A failed answer as a ProtocolError; `details.error` keeps the platform's own code. */
function failure(response: Response, text: string): ProtocolError {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const body = rec(JSON.parse(text));
    code = str(body?.error);
    message = str(body?.message);
  } catch {
    message = text.trim().slice(0, 300) || undefined;
  }
  const status = response.status;
  const said = message && message !== code ? message : code;
  const details = { status, ...(code ? { error: code } : {}) };
  if (status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    return new ProtocolError("rate_limited", `${LABEL} is rate limiting requests.`, {
      connector: ID,
      retry_after: Number.isFinite(retry) && retry > 0 ? retry : 60,
      details,
    });
  }
  if (status === 401)
    return new ProtocolError("auth_required", `${LABEL} refused the token (401). ${NEAR_MARKET_HELP}`, { connector: ID, details });
  if (status === 403) {
    return new ProtocolError(
      "auth_required",
      `${LABEL} refused the request (403): the job, bid, assignment or file belongs to someone else.`,
      {
        connector: ID,
        details,
      },
    );
  }
  if (status === 404) return new ProtocolError("not_found", `${LABEL} has nothing at that id.`, { connector: ID, details });
  if (code === "usd_not_accepted") {
    return new ProtocolError(
      "not_ready",
      `${LABEL}: USD jobs require an adopted builder account with Stripe connected (${PAYOUTS_PAGE}); USDC jobs and competitions work directly.${said && said !== code ? ` (${said})` : ""}`,
      { connector: ID, details },
    );
  }
  const mapped = code ? PLATFORM_CODES[code] : undefined;
  if (mapped) return new ProtocolError(mapped, `${LABEL}: ${said}`, { connector: ID, details });
  if (status === 413) return new ProtocolError("invalid_input", `${LABEL}: the request is too large.`, { connector: ID, details });
  return new ProtocolError(status >= 500 ? "upstream_error" : "invalid_input", `${LABEL} answered ${status}${said ? `: ${said}` : "."}`, {
    connector: ID,
    details,
  });
}

type CallOptions = { method?: "GET" | "POST" | "DELETE"; body?: unknown };

/** One JSON call to the agent API, authenticated unless the token is empty (sign-up). A path is read under /v1. */
async function call<T = Rec>(ctx: ConnectorContext, token: string, pathOrUrl: string, options: CallOptions = {}): Promise<T> {
  const url = /^https?:/u.test(pathOrUrl) ? pathOrUrl : `${NEAR_MARKET_API}${pathOrUrl}`;
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: ctx.signal,
    });
  } catch (error) {
    throw toProtocolError(error, ID);
  }
  const text = response.status === 204 ? "" : await response.text().catch(() => "");
  if (!response.ok) throw failure(response, text);
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ProtocolError("upstream_error", `${LABEL} did not answer with JSON.`, { connector: ID, cause: error });
  }
}

function requireToken(ctx: ConnectorContext): string {
  const token = ctx.credentials[TOKEN_ENV]?.trim();
  if (!token) throw new ProtocolError("auth_required", NEAR_MARKET_HELP, { connector: ID });
  return token;
}

function jobIdOf(nativeId: string): string {
  if (!UUID.test(nativeId)) {
    throw new ProtocolError("not_found", `${LABEL} job ids are UUIDs; ${JSON.stringify(nativeId)} is not one.`, { connector: ID });
  }
  return nativeId.toLowerCase();
}

function answer(input: ApplyInput, id: string): string | undefined {
  const value = input.answers?.[id];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || undefined;
}

/** The bid's price as the API takes it: a decimal string such as "25.00". */
function bidAmount(input: ApplyInput): string {
  const raw = answer(input, "amount") ?? input.preferred_rate?.trim();
  const value = raw ? Number(raw.replace(/[^\d.]/gu, "")) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProtocolError("invalid_input", `${LABEL} needs answers.amount: your price for the job, in its token (for example 25.00).`, {
      connector: ID,
    });
  }
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? value.toFixed(2) : amountText(value);
}

function slaSeconds(input: ApplyInput): number | undefined {
  const raw = answer(input, "delivery_hours");
  if (raw === undefined) return undefined;
  const hours = Number(raw.replace(/[^\d.]/gu, ""));
  const seconds = Math.round(hours * 3600);
  if (!Number.isFinite(hours) || seconds < 1 || seconds > SLA_MAX_SECONDS) {
    throw new ProtocolError("invalid_input", "answers.delivery_hours must be more than 0 and at most 720 (30 days).", { connector: ID });
  }
  return seconds;
}

/** Every row of one of the agent's own lists, newest first, up to MAX_PAGES pages. */
async function everyPage(ctx: ConnectorContext, token: string, route: string, field: "assignments" | "bids"): Promise<Rec[]> {
  const rows: Rec[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = rec(await call(ctx, token, `${route}?status=all&limit=${PAGE}&offset=${page * PAGE}`));
    const batch = recs(body?.[field]);
    rows.push(...batch);
    const total = num(body?.total);
    if (batch.length < PAGE || (total !== undefined && rows.length >= total)) break;
  }
  return rows;
}

const heldOf = (item: Rec): Held => ({
  ...(rec(item.assignment) ? { assignment: rec(item.assignment) } : {}),
  ...(rec(item.job) ? { job: rec(item.job) } : {}),
  ...(rec(item.latestMessage) ? { latest: rec(item.latestMessage) } : {}),
  ...(iso(item.autoAcceptAt) ? { autoAcceptAt: iso(item.autoAcceptAt) } : {}),
});

const jobOfItem = (item: Rec) => str(rec(item.assignment)?.jobId) ?? str(rec(item.job)?.jobId);

/** The agent's assignment on a job (a live one before a cancelled one), else its bid. */
async function findHeld(ctx: ConnectorContext, token: string, jobId: string): Promise<Held | undefined> {
  const items = (await everyPage(ctx, token, "/agents/me/assignments", "assignments")).filter((item) => jobOfItem(item) === jobId);
  const item = items.find((i) => str(rec(i.assignment)?.status) !== "cancelled") ?? items[0];
  if (item) return heldOf(item);
  const bid = (await everyPage(ctx, token, "/agents/me/bids", "bids")).find((b) => str(b.jobId) === jobId);
  return bid ? { bid } : undefined;
}

function defaultWorkFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = stateDir(env);
  return path.join(base, "near-agent-market-work.json");
}

/** Work added for a job's next delivery, kept on disk so a second process can submit it. */
class WorkStore {
  private memory: Record<string, Work> | undefined;

  constructor(private readonly file: string) {}

  private load(): Record<string, Work> {
    if (this.memory) return this.memory;
    try {
      this.memory = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Work>;
    } catch {
      this.memory = {};
    }
    return this.memory;
  }

  get(key: string): Work {
    const held = this.load()[key];
    return { files: [...(held?.files ?? [])], texts: [...(held?.texts ?? [])] };
  }

  set(key: string, work: Work): void {
    const all = this.load();
    if (work.files.length || work.texts.length) all[key] = work;
    else delete all[key];
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(all, null, 2));
    } catch {
      // memory still holds it for this process
    }
  }
}

/** Work is kept per token and job; the key holds a hash of the token, never the token. */
const workKey = (token: string, jobId: string) => `${createHash("sha256").update(token).digest("hex").slice(0, 16)}/${jobId}`;

function filesOf(work: Work): ApplicationFile[] {
  return [
    ...work.texts.map((t) => ({ id: t.id, name: `${t.id}.md`, kind: "text", size: bytesOf(t.text) })),
    ...work.files.map((f) => ({ id: f.id, name: f.name, kind: "file", size: f.size })),
  ];
}

/** The deliverable's Markdown: the note first, then the text added with add_work; a file list when there is only files. */
function markdownOf(note: string | undefined, work: Work): string {
  const parts = [note, ...work.texts.map((t) => t.text)].filter((p): p is string => Boolean(p?.trim()));
  if (parts.length) return parts.join("\n\n");
  if (!work.files.length) return "";
  return ["Delivered files:", "", ...work.files.map((f) => (f.url ? `- [${f.name}](${f.url})` : `- ${f.name}`))].join("\n");
}

export type NearAgentMarketOptions = {
  /** Where added work waits for submit_work. Default `$WORK_CACHE_DIR/near-agent-market-work.json`. */
  workFile?: string;
};

export function createNearAgentMarket(options: NearAgentMarketOptions = {}) {
  const store = perTenant(() => new WorkStore(options.workFile ?? defaultWorkFile()));

  /** Declares the start of an awarded, unstarted assignment (idempotent on the platform's side). */
  const start = async (ctx: ConnectorContext, token: string, held: Held): Promise<Held> => {
    const a = held.assignment;
    const id = str(a?.assignmentId);
    if (!a || !id || str(a.status) !== "in_progress" || str(a.startedAt) || isCompetition(held.job)) return held;
    const started = rec(await call(ctx, token, `/assignments/${id}/start`, { method: "POST" }));
    return { ...held, assignment: { ...a, startedAt: str(started?.startedAt) ?? new Date().toISOString() } };
  };

  /** The assignment work goes to, or the error that says why there is none yet. */
  const workable = async (
    ctx: ConnectorContext,
    token: string,
    jobId: string,
  ): Promise<Held & { assignment: Rec; assignmentId: string }> => {
    const held = await findHeld(ctx, token, jobId);
    if (!held) {
      throw new ProtocolError("not_ready", `No bid or entry of this agent on job ${jobId}: apply_to_job first.`, { connector: ID });
    }
    const a = held.assignment;
    if (!a) {
      const status = str(held.bid?.status);
      if (status === "rejected" || status === "withdrawn") {
        throw new ProtocolError("wrong_stage", `The bid on job ${jobId} was ${status}; it takes no work.`, {
          connector: ID,
          details: { stage: status },
        });
      }
      if (status === "accepted") {
        throw new ProtocolError("not_ready", "Awarded; the assignment opens once the escrow is funded. Try again in a minute.", {
          connector: ID,
        });
      }
      throw new ProtocolError("not_ready", "The bid is not awarded yet: work is delivered after the poster awards it and funds escrow.", {
        connector: ID,
      });
    }
    const status = str(a.status);
    if (status !== "in_progress" && status !== "submitted") {
      throw new ProtocolError(
        "wrong_stage",
        `The assignment on job ${jobId} is ${status?.replace(/_/gu, " ") ?? "closed"}; it takes no more work.`,
        {
          connector: ID,
          details: { stage: status ?? null },
        },
      );
    }
    const assignmentId = str(a.assignmentId);
    if (!assignmentId) throw new ProtocolError("upstream_error", `${LABEL} listed the assignment without an id.`, { connector: ID });
    return { ...held, assignment: a, assignmentId };
  };

  const ownEntry = async (ctx: ConnectorContext, token: string, held: Held): Promise<Rec | undefined> => {
    const a = held.assignment;
    const status = str(a?.status);
    if (!a || !isCompetition(held.job) || (status !== "accepted" && status !== "cancelled")) return undefined;
    try {
      const body = rec(await call(ctx, token, `/jobs/${str(a.jobId)}/entries`));
      const entries = recs(body?.entries);
      return entries.find((e) => str(e.assignmentId) === str(a.assignmentId)) ?? entries[0];
    } catch (error) {
      ctx.log("near-agent-market.entry_unread", { code: isProtocolError(error) ? error.code : "error" });
      return undefined;
    }
  };

  return defineConnector({
    id: ID,
    name: LABEL,
    description:
      "Paid jobs and prize competitions for AI agents on NEAR AI Agent Market: find jobs on the board, bid or enter, add files, deliver the result and follow each bid and assignment. Needs an agent token.",
    homepage: NEAR_MARKET,
    kinds: ["task"],
    category: "bounty",
    tier: "managed",
    payoutRails: ["crypto", "fiat"],
    auth: { type: "api_key", env: [TOKEN_ENV], help: NEAR_MARKET_HELP, required: true },

    async search(query, ctx) {
      if (query.kind === "listing") return { jobs: [] };
      const token = requireToken(ctx);
      const limit = query.limit ?? 20;
      const url = new URL(`${NEAR_MARKET_API}/jobs/board`);
      const words = query.query?.trim();
      if (words) url.searchParams.set("q", words);
      url.searchParams.set("limit", String(Math.min(100, limit + 1)));
      const body = rec(await call(ctx, token, url.href));
      const rows = recs(body?.jobs);
      const jobs = rows.map(jobToNative).filter((j): j is NativeJob => j !== null);
      const filtered = applyFilters(jobs, query, { query: true });
      return { jobs: filtered.slice(0, limit), more: rows.length > limit || filtered.length > limit };
    },

    async get(nativeId, ctx) {
      if (!UUID.test(nativeId)) return null;
      const token = requireToken(ctx);
      const job = rec(await call(ctx, token, `/jobs/${nativeId.toLowerCase()}`));
      return job ? jobToNative(job) : null;
    },

    async apply(nativeId, input, ctx) {
      const token = requireToken(ctx);
      const jobId = jobIdOf(nativeId);
      const files = filesOf(store().get(workKey(token, jobId)));
      const existing = await findHeld(ctx, token, jobId);
      if (existing) return toApplication(await start(ctx, token, existing), undefined, files);
      const job = rec(await call(ctx, token, `/jobs/${jobId}`)) ?? {};
      const status = str(job.status);
      if (status && status !== "open" && status !== "filling") {
        throw new ProtocolError("wrong_stage", `Job ${jobId} no longer takes bids or entries (${status.replace(/_/gu, " ")}).`, {
          connector: ID,
          details: { job_status: status },
        });
      }
      const again = async (error: unknown): Promise<NativeApplication> => {
        const code = isProtocolError(error) ? error.details?.error : undefined;
        if (code === "duplicate_bid" || code === "already_entered") {
          const held = await findHeld(ctx, token, jobId);
          if (held) return toApplication({ job, ...held }, undefined, files);
        }
        throw error;
      };
      if (isCompetition(job)) {
        try {
          const assignment = rec(await call(ctx, token, `/jobs/${jobId}/entries`, { method: "POST", body: {} }));
          return toApplication({ assignment: { jobId, ...assignment }, job }, undefined, files);
        } catch (error) {
          return again(error);
        }
      }
      const amount = bidAmount(input);
      const proposal = input.note?.trim();
      if (!proposal) {
        throw new ProtocolError("invalid_input", `${LABEL} needs note: the proposal the poster reads with your bid.`, { connector: ID });
      }
      const sla = slaSeconds(input);
      try {
        const bid = rec(
          await call(ctx, token, `/jobs/${jobId}/bids`, {
            method: "POST",
            body: { amount, proposal, ...(sla !== undefined ? { slaSeconds: sla } : {}) },
          }),
        );
        return bidToApplication({ jobId, amount, ...bid }, job, files);
      } catch (error) {
        return again(error);
      }
    },

    async upload(nativeApplicationId, work, ctx) {
      const token = requireToken(ctx);
      const jobId = jobIdOf(nativeApplicationId);
      const held = await workable(ctx, token, jobId);
      const key = workKey(token, jobId);
      const current = store().get(key);
      let file: ApplicationFile;
      if (work.kind === "text") {
        const text = work.text.trim();
        if (!text) throw new ProtocolError("invalid_input", "The text is empty.", { connector: ID });
        const same = current.texts.find((t) => t.text === text);
        if (same) {
          throw new ProtocolError("already_exists", "That text is already added for this delivery.", {
            connector: ID,
            details: { file: filesOf({ files: [], texts: [same] })[0] },
          });
        }
        const max = isCompetition(held.job) ? ENTRY_MARKDOWN_MAX : MARKDOWN_MAX;
        if (bytesOf(markdownOf(undefined, { files: [], texts: [...current.texts, { id: "new", text }] })) > max) {
          throw new ProtocolError("invalid_input", `The delivery's Markdown would pass ${max / 1024} KiB; send the rest as a file.`, {
            connector: ID,
          });
        }
        const n = Math.max(0, ...current.texts.map((t) => Number(t.id.replace(/^text-/u, "")) || 0)) + 1;
        const entry = { id: `text-${n}`, text };
        current.texts.push(entry);
        store().set(key, current);
        file = filesOf({ files: [], texts: [entry] })[0]!;
      } else {
        const size = work.bytes.byteLength;
        if (size === 0) throw new ProtocolError("invalid_input", `${work.name} is empty.`, { connector: ID });
        const sha256 = createHash("sha256").update(work.bytes).digest("hex");
        const same = current.files.find((f) => f.sha256 === sha256);
        if (same) {
          throw new ProtocolError("already_exists", `${same.name} is already added for this delivery.`, {
            connector: ID,
            details: { file: { id: same.id, name: same.name, kind: "file", size: same.size } },
          });
        }
        if (current.files.length >= FILES_MAX) {
          throw new ProtocolError("invalid_input", `A delivery carries at most ${FILES_MAX} files; remove_work one first.`, {
            connector: ID,
          });
        }
        if (current.files.reduce((sum, f) => sum + f.size, size) > FILE_BYTES_MAX) {
          throw new ProtocolError("invalid_input", "A delivery's files are at most 100 MiB together.", { connector: ID });
        }
        const reserved = rec(
          await call(ctx, token, "/files", { method: "POST", body: { filename: work.name, byteSize: size, link: true } }),
        );
        const fileId = str(reserved?.fileId);
        const target = str(reserved?.directUploadUrl) ?? str(reserved?.uploadUrl);
        if (!fileId || !target) {
          throw new ProtocolError("upstream_error", `${LABEL} reserved the file without an id and an upload URL.`, { connector: ID });
        }
        let put: Response;
        try {
          put = await ctx.fetch(new URL(target, NEAR_MARKET).href, {
            method: "PUT",
            headers: { "user-agent": USER_AGENT },
            body: work.bytes,
            signal: ctx.signal,
          });
        } catch (error) {
          throw toProtocolError(error, ID);
        }
        if (!put.ok) {
          throw new ProtocolError(
            "upstream_error",
            `The upload URL refused ${work.name} (${put.status}); add_work again for a fresh one.`,
            {
              connector: ID,
              details: { status: put.status },
            },
          );
        }
        const done = rec(await call(ctx, token, `/files/${fileId}/complete`, { method: "POST" }));
        const url = str(reserved?.fileUrl);
        const kept: HeldFile = {
          id: fileId,
          name: str(done?.filename) ?? work.name,
          size: num(done?.byteSize) ?? size,
          sha256,
          ...(url ? { url } : {}),
        };
        current.files.push(kept);
        store().set(key, current);
        file = { id: kept.id, name: kept.name, kind: "file", size: kept.size };
      }
      let started = "";
      try {
        const after = await start(ctx, token, held);
        if (after !== held) started = " Work declared started: the buyer may cancel only if the delivery deadline passes.";
      } catch (error) {
        ctx.log("near-agent-market.start_failed", { code: isProtocolError(error) ? error.code : "error" });
      }
      return {
        file,
        files: filesOf(current),
        next: `${file.kind === "text" ? "Added to the delivery's Markdown, after the note." : "Stored on the market."} submit_work delivers it with the rest (up to ${FILES_MAX} files).${started}`,
      } satisfies WorkReceipt;
    },

    async remove(nativeApplicationId, fileId, ctx) {
      const token = requireToken(ctx);
      const jobId = jobIdOf(nativeApplicationId);
      const key = workKey(token, jobId);
      const current = store().get(key);
      const text = current.texts.find((t) => t.id === fileId);
      if (text) {
        const rest = { files: current.files, texts: current.texts.filter((t) => t !== text) };
        store().set(key, rest);
        return { removed: { id: text.id, name: `${text.id}.md` }, files: filesOf(rest), next: "Removed from the next delivery." };
      }
      const held = current.files.find((f) => f.id === fileId);
      if (!held && !UUID.test(fileId)) {
        throw new ProtocolError("not_found", `No added work ${JSON.stringify(fileId)} on job ${jobId}.`, { connector: ID });
      }
      let next = "Deleted from the market and from the next delivery.";
      try {
        await call(ctx, token, `/files/${fileId}`, { method: "DELETE" });
      } catch (error) {
        if (!held || !isProtocolError(error) || error.details?.error !== "file_bound") throw error;
        next = "The job already holds this file (a delivered version or the thread keeps it); the next submit_work leaves it out.";
      }
      const rest = { files: current.files.filter((f) => f.id !== fileId), texts: current.texts };
      store().set(key, rest);
      return { removed: { id: fileId, name: held?.name ?? fileId }, files: filesOf(rest), next } satisfies WorkReceipt;
    },

    async submit(nativeApplicationId, input, ctx) {
      const token = requireToken(ctx);
      const jobId = jobIdOf(nativeApplicationId);
      const held = await workable(ctx, token, jobId);
      const key = workKey(token, jobId);
      const work = store().get(key);
      const markdown = markdownOf(input.note?.trim(), work);
      if (!markdown) {
        throw new ProtocolError(
          "not_ready",
          "Nothing to deliver yet: add_work with the result (text or files), or put the result in note.",
          {
            connector: ID,
          },
        );
      }
      const max = isCompetition(held.job) ? ENTRY_MARKDOWN_MAX : MARKDOWN_MAX;
      if (bytesOf(markdown) > max) {
        throw new ProtocolError("invalid_input", `The delivery's Markdown is over ${max / 1024} KiB; send the rest as a file.`, {
          connector: ID,
        });
      }
      const body = { deliverableMarkdown: markdown, ...(work.files.length ? { files: work.files.map((f) => f.url ?? f.id) } : {}) };
      const answer = rec(await call(ctx, token, `/assignments/${held.assignmentId}/submit`, { method: "POST", body }));
      const kept = { files: work.files, texts: [] };
      store().set(key, kept);
      return toApplication({ ...held, assignment: { ...held.assignment, ...answer } }, undefined, filesOf(kept));
    },

    async status(nativeApplicationId, ctx) {
      if (!UUID.test(nativeApplicationId)) return null;
      const token = requireToken(ctx);
      const jobId = nativeApplicationId.toLowerCase();
      const held = await findHeld(ctx, token, jobId);
      if (!held) return null;
      const files = filesOf(store().get(workKey(token, jobId)));
      if (!held.assignment) {
        let job: Rec | undefined;
        try {
          job = rec(await call(ctx, token, `/jobs/${jobId}`));
        } catch (error) {
          ctx.log("near-agent-market.job_unread", { code: isProtocolError(error) ? error.code : "error" });
        }
        return toApplication({ ...held, ...(job ? { job } : {}) }, undefined, files);
      }
      return toApplication(held, await ownEntry(ctx, token, held), files);
    },

    async list(ctx) {
      const token = requireToken(ctx);
      const [items, bids] = await Promise.all([
        everyPage(ctx, token, "/agents/me/assignments", "assignments"),
        everyPage(ctx, token, "/agents/me/bids", "bids"),
      ]);
      const byJob = new Map<string, Held>();
      for (const item of items) {
        const jobId = jobOfItem(item);
        if (!jobId) continue;
        const kept = byJob.get(jobId);
        if (!kept || (str(kept.assignment?.status) === "cancelled" && str(rec(item.assignment)?.status) !== "cancelled"))
          byJob.set(jobId, heldOf(item));
      }
      const bidOnly: string[] = [];
      for (const bid of bids) {
        const jobId = str(bid.jobId);
        if (jobId && !byJob.has(jobId)) {
          byJob.set(jobId, { bid });
          bidOnly.push(jobId);
        }
      }
      // A bid carries no job title: read the jobs (the most recent few), best effort.
      await Promise.all(
        bidOnly.slice(0, BID_JOBS_READ).map(async (jobId) => {
          try {
            const job = rec(await call(ctx, token, `/jobs/${jobId}`));
            if (job) byJob.set(jobId, { ...byJob.get(jobId)!, job });
          } catch (error) {
            ctx.log("near-agent-market.job_unread", { code: isProtocolError(error) ? error.code : "error" });
          }
        }),
      );
      return [...byJob.entries()].map(([jobId, held]) => toApplication(held, undefined, filesOf(store().get(workKey(token, jobId)))));
    },

    async link(nativeApplicationId, _ctx) {
      return { url: jobUrl(jobIdOf(nativeApplicationId)), signed_in: false };
    },

    async register(input, ctx) {
      const body = rec(
        await call(ctx, "", "/agents/register", {
          body: {
            handle: handleFor(input.handle ?? input.name ?? "kariaa-agent"),
            name: (input.name ?? input.handle ?? "Kariaa agent").trim().slice(0, 80) || "Kariaa agent",
            category: "other",
            email: input.email,
          },
        }),
      );
      const token = str(body?.apiToken);
      if (!token) throw new ProtocolError("upstream_error", `${LABEL} registered the agent but sent no token.`, { connector: ID });
      // The owner adopts the agent from this link; adoption moves its balance and lets them connect payouts.
      const adoption = rec(await call(ctx, token, "/agents/me/adoption-code", { method: "POST" }).catch(() => undefined));
      const link = str(adoption?.adoptionUrl);
      return {
        credentials: { [TOKEN_ENV]: token },
        account_id: str(body?.handle) ?? str(body?.agentId),
        next_step: link
          ? `Open ${link} signed in to market.near.ai to adopt the agent, then connect payouts at ${PAYOUTS_PAGE}. The link expires${adoption?.expiresAt ? ` ${day(str(adoption.expiresAt))}` : " soon"}.`
          : `Adopt the agent from its page on market.near.ai, then connect payouts at ${PAYOUTS_PAGE}.`,
      };
    },

    async account(ctx) {
      const token = ctx.credentials[TOKEN_ENV]?.trim();
      if (!token) return { signed_in: false, help: NEAR_MARKET_HELP };
      let me: Rec | undefined;
      try {
        me = rec(await call(ctx, token, "/me"));
      } catch (error) {
        if (!isProtocolError(error) || error.code !== "auth_required") throw error;
        await call(ctx, token, "/agents/me/bids?limit=1");
        return {
          signed_in: true,
          ready: true,
          profile: {
            account_id: null,
            display_name: null,
            verified: false,
            kyc_status: null,
            payout_schedule: null,
            adopted: false,
          },
          help: `Unadopted agent token: USDC jobs and competitions work now; adopt the agent and connect Stripe at ${PAYOUTS_PAGE} to bid on USD jobs.`,
        };
      }
      const account = rec(me?.account);
      const name = str(account?.display_name);
      return {
        signed_in: true,
        ...(name ? { label: name } : {}),
        ready: true,
        profile: {
          account_id: str(account?.account_id) ?? null,
          display_name: name ?? null,
          verified: account?.is_verified === true,
          kyc_status: account?.kyc_status ?? null,
          payout_schedule: account?.payout_schedule ?? null,
        },
      };
    },
  });
}

export const nearAgentMarket = createNearAgentMarket();
