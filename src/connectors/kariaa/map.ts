/**
 * Kariaa's tool results as protocol shapes. Pure functions; the shapes come from
 * Kariaa's `get_task`, `get_submission` and `search_jobs` / `get_job` tools.
 */
import type {
  ApplicationFile,
  ApplicationStage,
  Earning,
  Money,
  NativeApplication,
  NativeEarnings,
  NativeJob,
  NativePayout,
  Progress,
  Question,
  WorkReceipt,
} from "../../core/types.js";

export type Rec = Record<string, unknown>;

export const TASK_ORG = "Kariaa DataHouse";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []);
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function questions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const item of raw) {
    const q = rec(item);
    const id = str(q?.id);
    const question = str(q?.question);
    if (!q || !id || !question) continue;
    const type = q.type === "select" || q.type === "multiselect" || q.type === "url_list" ? q.type : "text";
    out.push({
      id,
      question,
      type,
      options: Array.isArray(q.options) ? list(q.options) : null,
      required: q.required === true,
    });
  }
  return out;
}

/** A `get_task` / `list_tasks` entry as a task job. */
export function taskToJob(task: Rec): NativeJob {
  const id = str(task.task_id);
  const title = str(task.title);
  if (!id || !title) throw new Error("Kariaa task without task_id or title");
  const pay = rec(task.pay);
  const amount = num(pay?.amount);
  const sample = rec(task.sample);
  const kinds = list(task.allowed_file_kinds);
  const textOnly = kinds.length > 0 && kinds.every((k) => k === "text");
  const rules = [...list(task.rules), ...list(task.program_rules)];
  const payDisplay =
    str(task.pay_display) ??
    (amount !== undefined ? `${str(pay?.currency) ?? "USD"} ${amount} ${str(pay?.unit) ?? "per sample"}` : undefined);
  const parts = [
    str(task.summary),
    sample && str(sample.instructions) ? `Verification sample (unpaid): ${str(sample.instructions)}` : undefined,
    str(task.pay_note),
  ].filter((p): p is string => Boolean(p));
  const job: NativeJob = {
    id,
    kind: "task",
    title,
    org: TASK_ORG,
    // agent-allowed: the task says an AI agent may do it itself (a challenge task).
    tags: [str(task.category), ...kinds, task.agent_allowed === true ? "agent-allowed" : undefined].filter((t): t is string => Boolean(t)),
  };
  if (str(task.summary)) job.summary = str(task.summary);
  if (parts.length) job.description = parts.join("\n\n");
  if (str(task.instructions)) job.instructions = str(task.instructions);
  if (str(task.url)) job.url = str(task.url);
  if (str(task.end_date)) job.expires_at = str(task.end_date);
  if (amount !== undefined || payDisplay) {
    job.pay = {
      ...(amount !== undefined ? { min: amount, max: amount, period: "unit" as const } : {}),
      ...(str(pay?.currency) ? { currency: str(pay?.currency) } : {}),
      ...(str(pay?.unit) ? { unit: str(pay?.unit) } : {}),
      ...(payDisplay ? { text: str(task.pay_note) ? `${payDisplay} after verification; samples are unpaid` : payDisplay } : {}),
    };
  } else if (str(task.pricing_note)) {
    job.pay = { text: str(task.pricing_note) };
  }
  const requirements: NonNullable<NativeJob["requirements"]> = {};
  const qs = questions(task.qualification_questions);
  if (qs.length) requirements.questions = qs;
  if (kinds.length) {
    requirements.files = {
      kinds,
      ...(num(sample?.count) !== undefined ? { count: num(sample?.count) } : {}),
      ...(num(sample?.max_duration_seconds) !== undefined ? { max_seconds: num(sample?.max_duration_seconds) } : {}),
      max_bytes: 100 * 1024 * 1024,
    };
  }
  if (textOnly) requirements.text = { min_chars: 20, max_chars: 20_000 };
  const howTo = list(sample?.how_to);
  if (howTo.length) requirements.how_to = howTo;
  const looksLike = str(sample?.looks_like) ?? str(sample?.example_idea);
  if (looksLike) requirements.looks_like = looksLike;
  if (rules.length) requirements.rules = rules;
  if (Object.keys(requirements).length) job.requirements = requirements;
  return job;
}

const STAGE: Record<string, ApplicationStage> = {
  pending_review: "applied",
  sample_needed: "work_needed",
  in_review: "in_review",
  approved: "accepted",
  rejected: "rejected",
  closed: "closed",
};

export function fileOf(raw: unknown): ApplicationFile | undefined {
  const f = rec(raw);
  const id = str(f?.id);
  if (!f || !id) return undefined;
  return {
    id,
    name: str(f.name) ?? id,
    kind: str(f.kind) ?? str(f.type) ?? "file",
    ...(num(f.size) !== undefined ? { size: num(f.size) } : {}),
  };
}

export function filesOf(raw: unknown): ApplicationFile[] {
  return Array.isArray(raw) ? raw.map(fileOf).filter((f): f is ApplicationFile => Boolean(f)) : [];
}

export function progressOf(raw: Rec): Progress | undefined {
  const received = num(raw.received);
  if (received === undefined) return undefined;
  const wanted = num(raw.wanted) ?? 0;
  return { received, wanted, ready_to_submit: raw.ready_to_submit === true };
}

/** A `confirm_upload` / `add_text_sample` / `remove_sample` result as a receipt. */
export function receiptOf(raw: Rec): WorkReceipt {
  const progress = progressOf(raw);
  const file = fileOf(raw.file);
  const removed = rec(raw.removed);
  const receipt: WorkReceipt = {};
  if (file) receipt.file = file;
  if (removed && str(removed.id)) receipt.removed = { id: str(removed.id)!, name: str(removed.name) ?? str(removed.id)! };
  if (Array.isArray(raw.staged_files)) receipt.files = filesOf(raw.staged_files);
  if (progress) {
    receipt.progress = progress;
    receipt.next = progress.ready_to_submit
      ? "Every sample is in. Call submit_work."
      : `${Math.max(0, progress.wanted - progress.received)} more to add, then submit_work.`;
  }
  return receipt;
}

/** Kariaa's hints and errors name its own tools; agents here use the Work API's. Same-named tools stay. */
const TOOL_WORDS: Array<[RegExp, string]> = [
  [/\(request_upload, PUT, confirm_upload each\)/gu, "(add_work with a file each)"],
  [/\brequest_upload, PUT, confirm_upload\b/gu, "add_work with a file"],
  [/\b(request_upload|confirm_upload|add_text_sample)\b/gu, "add_work"],
  [/\bsubmit_samples\b/gu, "submit_work"],
  [/\bremove_sample\b/gu, "remove_work"],
  [/\bget_submission\b/gu, "get_application"],
  [/\bmy_submissions\b/gu, "my_applications"],
  [/\blist_tasks\b/gu, "search_jobs"],
  [/\bget_task\b/gu, "get_job"],
  [/\bapply_to_task\b/gu, "apply_to_job"],
  [/\bget_upload_link\b/gu, "get_work_link"],
];

export function inWorkTerms(hint: string): string {
  return TOOL_WORDS.reduce((text, [pattern, word]) => text.replace(pattern, word), hint);
}

/** A `get_submission` / `my_submissions` entry as an application. */
export function submissionToApplication(sub: Rec): NativeApplication {
  const id = str(sub.submission_id);
  const jobId = str(sub.task_id);
  if (!id || !jobId) throw new Error("Kariaa submission without submission_id or task_id");
  const review = rec(sub.review);
  const app: NativeApplication = {
    id,
    job_id: jobId,
    stage: STAGE[str(sub.stage) ?? ""] ?? "closed",
  };
  if (str(sub.task_title)) app.job_title = str(sub.task_title);
  // Once submitted the staged files move to the review; review.files_count says how many went in.
  const sent = num(review?.files_count);
  if (Array.isArray(sub.staged_files) && (sub.staged_files.length > 0 || sent === undefined)) app.files = filesOf(sub.staged_files);
  const progress = progressOf(sub);
  if (progress && sent !== undefined && progress.received === 0) progress.received = sent;
  if (progress) app.progress = progress;
  if (str(sub.next)) app.next = inWorkTerms(str(sub.next)!);
  if (str(sub.applied_at)) app.created_at = str(sub.applied_at);
  const updated = str(review?.reviewed_at) ?? str(review?.submitted_at);
  if (updated) app.updated_at = updated;
  if (review) {
    const earned = num(review.earned_amount);
    const r: NonNullable<NativeApplication["review"]> = {};
    if (str(review.review_note)) r.note = str(review.review_note);
    if (earned !== undefined) r.earned = { amount: earned, currency: str(review.earned_currency) ?? "USD" };
    if (Object.keys(r).length) app.review = r;
  }
  return app;
}

/** A `search_jobs` row as a listing. */
export function listingToJob(row: Rec): NativeJob {
  const id = str(row.job_id);
  const title = str(row.title);
  if (!id || !title) throw new Error("Kariaa job row without job_id or title");
  const job: NativeJob = { id, kind: "listing", title };
  if (str(row.company)) job.org = str(row.company);
  const location = str(row.location);
  const remote = str(row.work_type)?.toLowerCase() === "remote";
  if (location || remote) job.location = { ...(location ? { text: location } : {}), ...(remote ? { remote: true } : {}) };
  if (str(row.pay)) job.pay = { text: str(row.pay) };
  if (str(row.posted)) job.posted_at = str(row.posted);
  if (str(row.url)) job.url = str(row.url);
  const tags = [str(row.source) ? `source:${str(row.source)}` : undefined, str(row.match) ? `match:${str(row.match)}` : undefined].filter(
    (t): t is string => Boolean(t),
  );
  if (tags.length) job.tags = tags;
  return job;
}

function moneyOf(raw: unknown, fallbackCurrency = "USD"): Money | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return { amount: raw, currency: fallbackCurrency };
  const m = rec(raw);
  const amount = num(m?.amount);
  if (!m || amount === undefined) return undefined;
  return { amount, currency: str(m.currency) ?? fallbackCurrency };
}

const PAYOUT_STATUS: Record<string, NativePayout["status"]> = {
  requested: "requested",
  pending: "requested",
  paid: "paid",
  rejected: "rejected",
  cancelled: "cancelled",
  canceled: "cancelled",
};
const EARNING_STATUS: Record<string, Earning["status"]> = {
  pending: "pending",
  available: "available",
  paid: "paid",
  credited: "available",
};

/** A `request_payout` result, or one entry of `my_earnings.payouts`, as a payout. */
export function payoutOf(raw: Rec, fallbackCurrency = "USD"): NativePayout {
  const id = str(raw.payout_id) ?? str(raw.id);
  const amount = moneyOf(raw.amount, str(raw.currency) ?? fallbackCurrency);
  if (!id || !amount) throw new Error("Kariaa payout without id or amount");
  const payout: NativePayout = {
    id,
    amount,
    method: str(raw.method) ?? "unknown",
    status: PAYOUT_STATUS[str(raw.status) ?? ""] ?? "requested",
  };
  if (str(raw.destination)) payout.destination = str(raw.destination);
  if (str(raw.requested_at)) payout.requested_at = str(raw.requested_at);
  if (str(raw.paid_at)) payout.paid_at = str(raw.paid_at);
  if (str(raw.note)) payout.note = str(raw.note);
  return payout;
}

/** A `my_earnings` result as earnings. */
export function earningsOf(raw: Rec): NativeEarnings {
  const currency = str(raw.currency) ?? str(rec(raw.balance)?.currency) ?? "USD";
  const balance = moneyOf(raw.balance, currency) ?? { amount: 0, currency };
  const earnings: NativeEarnings = { balance };
  const total = moneyOf(raw.total_earned, currency);
  if (total) earnings.total_earned = total;
  const pending = moneyOf(raw.pending, currency);
  if (pending) earnings.pending = pending;
  const minPayout = moneyOf(raw.min_payout, currency);
  if (minPayout) earnings.min_payout = minPayout;
  if (Array.isArray(raw.methods)) earnings.methods = list(raw.methods);
  if (Array.isArray(raw.entries)) {
    earnings.entries = (raw.entries as unknown[]).flatMap((item) => {
      const e = rec(item);
      const id = str(e?.id) ?? str(e?.earning_id);
      const amount = num(e?.amount);
      if (!e || !id || amount === undefined) return [];
      const entry: Earning = {
        id,
        amount,
        currency: str(e.currency) ?? currency,
        status: EARNING_STATUS[str(e.status) ?? ""] ?? "available",
      };
      const applicationId = str(e.submission_id) ?? str(e.application_id);
      if (applicationId) entry.application_id = applicationId;
      if (str(e.task_title) ?? str(e.job_title)) entry.job_title = str(e.task_title) ?? str(e.job_title);
      if (str(e.earned_at) ?? str(e.created_at)) entry.earned_at = str(e.earned_at) ?? str(e.created_at);
      if (str(e.note)) entry.note = str(e.note);
      return [entry];
    });
  }
  if (Array.isArray(raw.payouts)) {
    earnings.payouts = (raw.payouts as unknown[]).flatMap((item) => {
      const p = rec(item);
      if (!p) return [];
      try {
        return [payoutOf(p, currency)];
      } catch {
        return [];
      }
    });
  }
  if (str(raw.help)) earnings.help = str(raw.help);
  return earnings;
}

/** A `get_job` result as a listing with its description. */
export function postingToJob(row: Rec): NativeJob {
  const job = listingToJob(row);
  const description = str(row.description);
  const requirements = str(row.requirements);
  if (description || requirements) {
    job.description = [description, requirements ? `Requirements:\n${requirements}` : undefined].filter(Boolean).join("\n\n");
  }
  if (description) job.summary = description.length > 300 ? `${description.slice(0, 300).trimEnd()}…` : description;
  if (str(row.how_to_apply)) job.apply_hint = `${str(row.how_to_apply)}${job.url ? ` ${job.url}` : ""}`;
  return job;
}
