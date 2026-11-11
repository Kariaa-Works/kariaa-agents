/**
 * Run traces: every protocol call a workflow makes, as one JSON line each.
 * `work trace -- <command>` sets WORK_TRACE_FILE; `createProtocol` (and so the
 * MCP server and the CLI) then records to it. `work watch` replays the file.
 *
 * A trace is meant to be committed with a workflow, so nothing personal goes
 * in: keys, tokens, emails and phone numbers are masked, file bytes are left
 * out, and long text is cut.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { WorkProtocol } from "./router.js";

export const TRACE_VERSION = 1;

/** The protocol calls a trace records, and the step of the loop each one belongs to. */
export const TRACED_OPS = {
  search: "find",
  get: "find",
  resolve: "find",
  apply: "apply",
  upload: "do",
  remove: "do",
  verify: "verify",
  submit: "submit",
  status: "track",
  list: "track",
  link: "track",
  accounts: "account",
  earnings: "paid",
  requestPayout: "paid",
  // giving work out
  post: "post",
  postings: "post",
  offers: "hire",
  award: "hire",
  review: "review",
  pay: "pay",
  cancelPosting: "post",
} as const;

export type TracedOp = keyof typeof TRACED_OPS;
export type TraceStep = (typeof TRACED_OPS)[TracedOp];

export type TraceEvent =
  | { type: "start"; v: number; ts: string; run: string; name?: string; command?: string }
  | {
      type: "call";
      ts: string;
      op: TracedOp;
      step: TraceStep;
      input: unknown;
      ok: boolean;
      ms: number;
      output?: unknown;
      error?: { code: string; message: string };
    }
  | { type: "end"; ts: string; exit: number; ms: number };

const SECRET_KEY = /key|token|secret|password|authorization|credential|cookie|signature/iu;
const PERSONAL_KEY =
  /^(email|phone|phone_number|mobile|address|street|postal_code|zip|destination|legal_name|legal_first_name|legal_last_name|full_name|first_name|last_name|name_on_account|label|location|city|date_of_birth|dob|linkedin|linkedin_url|website|handle|username|wallet|wallet_address|tax_id|ssn)$/iu;
const SECRET_VALUE =
  /\b(kra_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/gu;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const SIGNED_URL =
  /([?&#](?:X-Amz-[A-Za-z-]+|sig|signature|token|token_hash|access_token|refresh_token|code|key|otp|sv|se|sp)=)[^&\s"]+/giu;
// Not ids or links: a number right after ":", "/", "=", "~" or "-" is left alone.
const PHONE = /(?<![\w.:/=~#-])\+?\d[\d\s().-]{7,}\d(?!\w)/gu;
/** A home folder in a path names the person: C:\\Users\\sam\\…, /Users/sam/…, /home/sam/…. */
const HOME_PATH = /((?:[A-Za-z]:)?[\\/](?:Users|home)[\\/])[^\\/\s"']+/gu;

const MAX_TEXT = 280;
const MAX_ITEMS = 50;
const MAX_DEPTH = 6;

function cleanText(value: string): string {
  const masked = value
    .replace(SECRET_VALUE, "[redacted]")
    .replace(EMAIL, "[email]")
    .replace(SIGNED_URL, "$1[redacted]")
    .replace(HOME_PATH, "$1[user]")
    .replace(PHONE, (m) => (m.replace(/\D/gu, "").length >= 9 ? "[phone]" : m));
  return masked.length > MAX_TEXT ? `${masked.slice(0, MAX_TEXT)}… (${masked.length} chars)` : masked;
}

/** A copy of a value that is safe to publish and small enough to read. */
export function redact(value: unknown, depth = 0, key = ""): unknown {
  if (value === null || value === undefined) return value;
  // A link that signs the person in is kept as its address only.
  if (typeof value === "string")
    return key === "url" && /[?#]/u.test(value) && /sign|login|auth|magic|verify|link/iu.test(value)
      ? cleanText(value.split(/[?#]/u)[0]!)
      : cleanText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`… ${value.length - MAX_ITEMS} more`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    if (key === "raw" || key === "embedding") continue;
    if (key === "base64" || key === "bytes") {
      out[key] = "[bytes left out]";
      continue;
    }
    if (SECRET_KEY.test(key) && typeof item !== "boolean" && typeof item !== "number") {
      out[key] = "[redacted]";
      continue;
    }
    if (PERSONAL_KEY.test(key) && typeof item === "string") {
      out[key] = "[personal]";
      continue;
    }
    if (key === "profile" && item && typeof item === "object") {
      out[key] = "[profile left out]";
      continue;
    }
    out[key] = redact(item, depth + 1, key);
  }
  return out;
}

/** A search result keeps every job it found, as one short line each; the full job is in the `get` that follows. */
function shape(op: TracedOp, output: unknown): unknown {
  if (op !== "search" || !output || typeof output !== "object") return output;
  const result = output as { jobs?: unknown; more?: unknown; partial?: unknown };
  if (!Array.isArray(result.jobs)) return output;
  return {
    count: result.jobs.length,
    more: result.more,
    partial: result.partial,
    jobs: (result.jobs as Array<Record<string, unknown>>).map((job) => ({
      id: job.id,
      title: job.title,
      org: job.org,
      kind: job.kind,
      pay: (job.pay as { text?: unknown } | undefined)?.text,
      remote: (job.location as { remote?: unknown } | undefined)?.remote,
      stages: job.stages,
    })),
  };
}

/** Appends one event to a trace file, creating the folder on first use. Never throws: tracing must not break a run. */
export function appendTrace(file: string, event: TraceEvent): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // A read-only disk loses the trace, not the run.
  }
}

/** Reads a trace file; lines that are not events are skipped. */
export function readTrace(file: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as TraceEvent;
      if (event && typeof event === "object" && typeof event.type === "string") events.push(event);
    } catch {
      // Skip a half-written line.
    }
  }
  return events;
}

/** Set while a traced call runs, so the calls it makes itself (verify reads the job) are not recorded twice. */
const inCall = new AsyncLocalStorage<true>();

/**
 * Records every traced call on this protocol to `file`. The protocol is
 * changed in place and returned, so callers keep one object.
 */
export function traceProtocol<P extends WorkProtocol>(protocol: P, file: string, now: () => number = Date.now): P {
  const target = protocol as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const op of Object.keys(TRACED_OPS) as TracedOp[]) {
    const original = target[op];
    if (typeof original !== "function") continue;
    target[op] = async (...args: unknown[]) => {
      if (inCall.getStore()) return original.apply(protocol, args);
      const started = now();
      const base = { type: "call" as const, ts: new Date(started).toISOString(), op, step: TRACED_OPS[op], input: redact(args) };
      try {
        const output = await inCall.run(true, () => original.apply(protocol, args));
        appendTrace(file, { ...base, ok: true, ms: now() - started, output: redact(shape(op, output)) });
        return output;
      } catch (error) {
        const err = error as { code?: unknown; message?: unknown };
        appendTrace(file, {
          ...base,
          ok: false,
          ms: now() - started,
          error: {
            code: typeof err?.code === "string" ? err.code : "error",
            message: cleanText(typeof err?.message === "string" ? err.message : String(error)),
          },
        });
        throw error;
      }
    };
  }
  return protocol;
}

export type TraceSummary = {
  run?: string;
  name?: string;
  calls: number;
  failed: number;
  ms: number;
  steps: Record<TraceStep, number>;
  found: number;
  applied: number;
  verified: { pass: number; fail: number; uncertain: number };
  submitted: number;
  accepted: number;
  connectors: string[];
  exit?: number;
};

function connectorOf(id: unknown): string | undefined {
  return typeof id === "string" && id.includes(":") ? id.slice(0, id.indexOf(":")) : undefined;
}

/** What a run did, in numbers: the scorecard `work trace` prints and `work watch` shows. */
export function summarizeTrace(events: TraceEvent[]): TraceSummary {
  const summary: TraceSummary = {
    calls: 0,
    failed: 0,
    ms: 0,
    steps: { find: 0, apply: 0, do: 0, verify: 0, submit: 0, track: 0, account: 0, paid: 0, post: 0, hire: 0, review: 0, pay: 0 },
    found: 0,
    applied: 0,
    verified: { pass: 0, fail: 0, uncertain: 0 },
    submitted: 0,
    accepted: 0,
    connectors: [],
  };
  const connectors = new Set<string>();
  const found = new Set<string>();
  const accepted = new Set<string>();
  for (const event of events) {
    if (event.type === "start") {
      summary.run = event.run;
      if (event.name) summary.name = event.name;
      continue;
    }
    if (event.type === "end") {
      summary.exit = event.exit;
      summary.ms = event.ms;
      continue;
    }
    summary.calls += 1;
    summary.steps[event.step] += 1;
    if (!event.ok) {
      summary.failed += 1;
      continue;
    }
    const out = (event.output ?? {}) as Record<string, unknown>;
    const first = Array.isArray(event.input) ? event.input[0] : undefined;
    const named = connectorOf(first) ?? connectorOf(out.id) ?? (typeof out.connector === "string" ? out.connector : undefined);
    if (named) connectors.add(named);
    if (event.op === "search" && Array.isArray(out.jobs)) {
      for (const job of out.jobs as Array<Record<string, unknown>>) {
        if (job && typeof job === "object" && typeof job.id === "string") {
          found.add(job.id);
          const c = connectorOf(job.id);
          if (c) connectors.add(c);
        }
      }
    }
    if (event.op === "apply") summary.applied += 1;
    if (event.op === "submit") summary.submitted += 1;
    if (event.op === "verify") {
      const outcome = out.outcome;
      if (outcome === "pass" || outcome === "fail" || outcome === "uncertain") summary.verified[outcome] += 1;
    }
    if ((event.op === "status" || event.op === "submit" || event.op === "apply") && out.stage === "accepted" && typeof out.id === "string")
      accepted.add(out.id);
  }
  summary.found = found.size;
  summary.accepted = accepted.size;
  summary.connectors = [...connectors].sort();
  if (!summary.ms) {
    const calls = events.filter((e) => e.type === "call");
    const firstCall = calls[0];
    const lastCall = calls[calls.length - 1];
    if (firstCall && lastCall)
      summary.ms = Date.parse(lastCall.ts) - Date.parse(firstCall.ts) + (lastCall.type === "call" ? lastCall.ms : 0);
  }
  return summary;
}
