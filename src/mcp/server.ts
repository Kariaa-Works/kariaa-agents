/**
 * The unified API as an MCP server: 24 tools, a guide resource and a prompt.
 * Errors are returned as results (`isError`), never thrown across the wire.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Connection } from "../core/connect.js";
import { ProtocolError, toProtocolError } from "../core/errors.js";
import type { ConnectorInfo, WorkProtocol } from "../core/router.js";
import {
  AccountSchema,
  ApplicationSchema,
  CONNECTOR_CATEGORIES,
  EarningsSchema,
  JobSchema,
  LinkSchema,
  MEDIA_KINDS,
  PartialFailureSchema,
  PayoutSchema,
  WorkReceiptSchema,
  PostingSchema,
  PaymentSchema,
  OfferSchema,
  WORKER_KINDS,
  type Account,
  type Application,
  type Earnings,
  type Job,
  type Money,
  type PartialFailure,
  type Payout,
  type WorkReceipt,
  type Posting,
  type Payment,
  type Offer,
} from "../core/types.js";
import { VerificationSchema, type Verification } from "../core/verifier.js";
import { VERSION } from "../core/version.js";
import { GUIDE_MARKDOWN, SERVER_INSTRUCTIONS } from "./guide.js";

export type WorkMcpServerOptions = {
  /** Whether `add_work` may read `file.path`; only true for a process the person runs themselves. */
  allowLocalFiles?: boolean;
  name?: string;
  version?: string;
};

export const WORK_MCP_TOOLS = [
  "list_connectors",
  "search_jobs",
  "get_job",
  "apply_to_job",
  "add_work",
  "remove_work",
  "submit_work",
  "get_application",
  "my_applications",
  "get_work_link",
  "whoami",
  "connect_account",
  "save_credentials",
  "update_profile",
  "my_earnings",
  "request_payout",
  "verify_work",
  "post_job",
  "my_postings",
  "list_offers",
  "award_offer",
  "review_work",
  "pay_for_work",
  "cancel_posting",
] as const;

const GUIDE_URI = "work://guide";

// ---- output schemas ----
// Clients validate structuredContent against these, for error results too. So every
// top-level field is optional, extra fields pass through, and an error result carries
// only `error`, `message`, `connector`, `retry_after` and `details`.

const ERROR_FIELDS = {
  error: z.string().optional(),
  message: z.string().optional(),
  connector: z.string().optional(),
  retry_after: z.number().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

function out(schema: z.ZodObject) {
  return schema.partial().extend(ERROR_FIELDS).passthrough();
}

const TIER_TEXT = {
  managed: "Kariaa can set the account up",
  self: "link your own account",
  discover: "listings only: you act on the site",
} as const;

const ConnectorInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    homepage: z.string().optional(),
    kinds: z.array(z.string()),
    category: z.string().optional().describe("How the source pays: bounty, micro_task, selling, competition or job."),
    payout_rails: z.array(z.string()).optional().describe("Where the money lands: fiat, crypto, employer."),
    stages: z.array(z.string()),
    opt_in: z.boolean().optional().describe("true: searched only when named in connectors."),
    tier: z
      .enum(["managed", "self", "discover"])
      .optional()
      .describe(
        "In the curated catalog. managed: Kariaa can set the account up (connect_account); self: works once the person links their own account; discover: listings only, the person acts on the site.",
      ),
    ask_first: z.boolean().optional().describe("true: every action waits for the person's approval."),
    health: z
      .enum(["ok", "down"])
      .optional()
      .describe("down: the platform failed its last searches; it is left out of searches until it answers again."),
    auth: z
      .object({
        type: z.string(),
        configured: z.boolean(),
        required: z.boolean(),
        env: z.array(z.string()).optional(),
        help: z.string().optional(),
      })
      .passthrough(),
    profileFields: z
      .array(z.object({ name: z.string(), description: z.string(), example: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

const JobSummarySchema = JobSchema.omit({ description: true, raw: true }).passthrough();
const ApplicationItem = ApplicationSchema.passthrough();
const AccountItem = AccountSchema.extend({ connector: z.string() }).passthrough();
const JobOut = out(JobSchema);
const ApplicationOut = out(ApplicationSchema);
const ReceiptOut = out(WorkReceiptSchema.extend({ application_id: z.string() }));
const AccountOut = out(AccountSchema.extend({ connector: z.string() }));
const EarningsItem = EarningsSchema.passthrough();
const PayoutOut = out(PayoutSchema);
const VerificationOut = out(VerificationSchema.extend({ job_id: z.string() }));
const ConnectionSchema = z
  .object({
    connector: z.string(),
    name: z.string(),
    status: z.enum(["connected", "action_needed"]),
    method: z.enum(["none", "register", "oauth", "api_key"]),
    account: AccountSchema.passthrough().optional(),
    registered: z.object({ account_id: z.string().optional(), next_step: z.string().optional() }).optional(),
    steps: z.array(z.string()).optional(),
    fields: z.array(z.string()).optional(),
    url: z.string().optional(),
    needs: z.array(z.string()).optional(),
    stored: z.string().optional(),
  })
  .passthrough();

const FileInput = z.object({
  path: z.string().optional(),
  url: z.string().optional(),
  base64: z.string().optional(),
  name: z.string().max(200).optional(),
  mime_type: z.string().max(100).optional(),
});

// ---- rendering (the text beside structuredContent) ----

const cash = (m?: { amount: number; currency: string }) => (m ? `${m.amount} ${m.currency}` : "");

export function renderPosting(p: Posting): string {
  const bits = [
    p.status.replace(/_/gu, " "),
    cash(p.budget),
    p.funded === undefined ? "" : p.funded ? "money set aside" : "not funded yet",
  ];
  if (p.offers !== undefined) bits.push(`${p.offers} offer${p.offers === 1 ? "" : "s"}`);
  return [
    `${p.id}`,
    `  ${p.title} · ${bits.filter(Boolean).join(" · ")}`,
    ...(p.next ? [`  Next: ${p.next}`] : []),
    ...(p.url ? [`  ${p.url}`] : []),
  ].join("\n");
}

export function renderOffer(o: Offer): string {
  const who = [
    o.from.name ?? o.from.id ?? "someone",
    o.from.kind && o.from.kind !== "unknown" ? `(${o.from.kind})` : "",
    o.from.rating !== undefined ? `rated ${o.from.rating}` : "",
  ];
  const terms = [cash(o.amount), o.days !== undefined ? `${o.days} day${o.days === 1 ? "" : "s"}` : "", o.status];
  const lines = [`${o.id} · ${who.filter(Boolean).join(" ")} · ${terms.filter(Boolean).join(" · ")}`];
  if (o.note) lines.push(`  ${o.note.length > 300 ? `${o.note.slice(0, 297)}…` : o.note}`);
  if (o.delivery?.text) lines.push(`  Delivered: ${o.delivery.text.length > 300 ? `${o.delivery.text.slice(0, 297)}…` : o.delivery.text}`);
  for (const url of o.delivery?.urls ?? []) lines.push(`  Delivered: ${url}`);
  return lines.join("\n");
}

export function renderPayment(p: Payment): string {
  const head =
    p.status === "confirm_needed"
      ? "Nothing has moved yet."
      : `${p.action === "fund" ? "Set aside" : p.action === "release" ? "Released" : "Paid"}: ${p.status}`;
  const lines = [`${head} ${cash(p.amount)}${p.to ? ` → ${p.to}` : ""}${p.fee ? ` (fee ${cash(p.fee)})` : ""}`.trim()];
  if (p.confirm) lines.push(`Confirm token: ${p.confirm}`);
  if (p.next) lines.push(p.next);
  return lines.join("\n");
}

/** Pay as the job shows it: the source's own words, else currency, amount or range, and period. */
export function payText(job: Job): string | undefined {
  const p = job.pay;
  if (!p) return undefined;
  if (p.text) return p.text;
  const range = p.min !== undefined && p.max !== undefined && p.min !== p.max ? `${p.min}–${p.max}` : (p.min ?? p.max)?.toString();
  if (!range) return undefined;
  const period = p.period === "unit" ? (p.unit ?? "per unit") : p.period ? `per ${p.period}` : "";
  return [p.currency, range, period].filter(Boolean).join(" ");
}

function where(job: Job): string | undefined {
  const parts = [job.location?.text, job.location?.remote ? "remote" : undefined].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

export function renderJobLine(job: Job): string {
  const head = [job.title, job.org, where(job), payText(job)].filter(Boolean).join(" · ");
  const tail =
    job.kind === "task" ? `task · ${job.stages.join(", ") || "view only"}` : `listing · ${job.apply_hint ?? job.url ?? ""}`.trim();
  // The one tag an agent picks work by: a task the platform says an agent may do.
  const open = job.tags?.includes("agent-allowed") ? " · agent-allowed" : "";
  return `${job.id}\n  ${head}\n  ${tail}${open}`;
}

export function renderJob(job: Job): string {
  const lines = [renderJobLine(job)];
  if (job.summary && !job.description) lines.push("", job.summary);
  if (job.description) lines.push("", job.description);
  if (job.instructions) lines.push("", `Material:\n${job.instructions}`);
  const r = job.requirements;
  if (r?.questions?.length) {
    lines.push("", "Questions:");
    for (const q of r.questions) {
      lines.push(
        `- [${q.id}] ${q.question}${q.required ? " (required)" : ""}${q.options?.length ? ` Options: ${q.options.map((o, i) => `${i + 1}. ${o}`).join(" / ")}` : ""}`,
      );
    }
  }
  if (r?.files) {
    lines.push(
      "",
      `Files: ${r.files.count ?? 1} × ${r.files.kinds.join("/")}${r.files.max_seconds ? ` (up to ${r.files.max_seconds} s each)` : ""}`,
    );
  }
  if (r?.text) lines.push(`Written answer: ${r.text.min_chars ?? 1}–${r.text.max_chars ?? "∞"} characters`);
  if (r?.how_to?.length) lines.push("", "How to:", ...r.how_to.map((s, i) => `${i + 1}. ${s}`));
  if (r?.looks_like) lines.push("", `A good one looks like: ${r.looks_like}`);
  if (r?.rules?.length) lines.push("", "Rules:", ...r.rules.map((s) => `- ${s}`));
  if (job.url) lines.push("", job.url);
  return lines.join("\n");
}

export function renderApplication(app: Application): string {
  const lines = [`${app.id} · ${app.job_title ?? app.job_id} · ${app.stage}`];
  if (app.progress)
    lines.push(`${app.progress.received} of ${app.progress.wanted} in${app.progress.ready_to_submit ? ", ready to submit" : ""}`);
  if (app.files?.length)
    lines.push(...app.files.map((f) => `- ${f.id} ${f.name} (${f.kind}${f.size ? `, ${Math.round(f.size / 1024)} KB` : ""})`));
  if (app.review?.note) lines.push(`Review: ${app.review.note}`);
  if (app.review?.earned) lines.push(`Earned: ${app.review.earned.currency} ${app.review.earned.amount}`);
  if (app.next) lines.push(`Next: ${app.next}`);
  if (app.url) lines.push(app.url);
  return lines.join("\n");
}

export function renderReceipt(receipt: WorkReceipt & { application_id: string }): string {
  const lines: string[] = [];
  if (receipt.file) lines.push(`Added ${receipt.file.name} (${receipt.file.id})`);
  if (receipt.removed) lines.push(`Removed ${receipt.removed.name}`);
  if (receipt.progress)
    lines.push(
      `${receipt.progress.received} of ${receipt.progress.wanted} in${receipt.progress.ready_to_submit ? ", ready to submit" : ""}`,
    );
  if (receipt.next) lines.push(receipt.next);
  return lines.join("\n") || "Done.";
}

export function renderAccount(account: Account & { connector: string }): string {
  if (!account.signed_in) return `${account.connector}: not signed in. ${account.help ?? ""}`.trim();
  const bits = [
    account.label ? `as ${account.label}` : undefined,
    account.ready ? "ready to apply" : `missing: ${account.missing?.join(", ") || "nothing"}`,
  ];
  const usage = account.usage
    ? ` · ${account.usage.calls}/${account.usage.calls_max} calls, ${account.usage.writes}/${account.usage.writes_max} writes today`
    : "";
  const rejected = account.rejected?.length ? `\n  rejected: ${account.rejected.map((r) => `${r.field} (${r.reason})`).join(", ")}` : "";
  return `${account.connector}: signed in ${bits.filter(Boolean).join(", ")}${usage}${rejected}`;
}

const money = (m: Money | undefined): string | undefined => (m ? `${m.currency} ${m.amount}` : undefined);

export function renderPayout(payout: Payout): string {
  const line = `${payout.id} · ${money(payout.amount)} via ${payout.method}${payout.destination ? ` to ${payout.destination}` : ""} · ${payout.status}`;
  const when = payout.paid_at ? `paid ${payout.paid_at}` : payout.requested_at ? `requested ${payout.requested_at}` : undefined;
  return [line, when, payout.note].filter(Boolean).join("\n  ");
}

export function renderEarnings(earnings: Earnings): string {
  const lines = [`${earnings.connector}: balance ${money(earnings.balance)}`];
  const extras = [
    earnings.pending ? `pending ${money(earnings.pending)}` : undefined,
    earnings.total_earned ? `earned so far ${money(earnings.total_earned)}` : undefined,
  ].filter(Boolean);
  if (extras.length) lines.push(`  ${extras.join(" · ")}`);
  if (earnings.min_payout || earnings.methods?.length) {
    lines.push(
      `  payout: ${[earnings.min_payout ? `from ${money(earnings.min_payout)}` : undefined, earnings.methods?.length ? `via ${earnings.methods.join(", ")}` : undefined].filter(Boolean).join(" ")}`,
    );
  }
  for (const entry of (earnings.entries ?? []).slice(0, 8)) {
    lines.push(
      `  - ${entry.currency} ${entry.amount} · ${entry.job_title ?? entry.application_id ?? entry.id} · ${entry.status}${entry.earned_at ? ` · ${entry.earned_at.slice(0, 10)}` : ""}`,
    );
  }
  for (const payout of (earnings.payouts ?? []).slice(0, 5)) lines.push(`  ↳ ${renderPayout(payout)}`);
  if (earnings.help) lines.push(`  ${earnings.help}`);
  return lines.join("\n");
}

export function renderVerification(v: Verification & { job_id?: string }): string {
  const lines = [v.summary];
  for (const verdict of v.verdicts) {
    lines.push(
      `${verdict.verifier}: ${verdict.outcome}${verdict.accepted_units !== undefined ? ` (${verdict.accepted_units} accepted)` : ""}`,
    );
    for (const check of verdict.checks) {
      if (check.ok && check.details?.readable !== false) continue;
      lines.push(`  - ${check.ok ? "?" : "✗"} ${check.message}`);
    }
  }
  if (v.pay) lines.push(`Pay for the accepted pieces: ${v.pay.currency} ${v.pay.amount}`);
  return lines.join("\n");
}

export function renderConnection(c: Connection): string {
  const head = `${c.connector} · ${c.name} · ${c.status === "connected" ? "connected" : "not connected"}${c.account?.label ? ` as ${c.account.label}` : ""}`;
  const lines = [head];
  if (c.registered)
    lines.push(
      `  Registered${c.registered.account_id ? ` ${c.registered.account_id}` : ""}.${c.registered.next_step ? ` ${c.registered.next_step}` : ""}`,
    );
  if (c.stored) lines.push(`  Kept in ${c.stored}.`);
  for (const [i, step] of (c.steps ?? []).entries()) lines.push(`  ${c.status === "connected" ? "-" : `${i + 1}.`} ${step}`);
  return lines.join("\n");
}

export function renderConnectors(connectors: ConnectorInfo[]): string {
  return connectors
    .map((c) => {
      const auth =
        c.auth.type === "none"
          ? "no key needed"
          : c.auth.configured
            ? "key set"
            : c.auth.required
              ? `needs ${c.auth.env?.join(" + ")}`
              : `key optional (${c.auth.env?.join(" + ")})`;
      const optIn = c.opt_in ? " · searched only when named" : c.tier ? ` · ${TIER_TEXT[c.tier]}` : "";
      const pays = c.category ? ` · ${c.category}${c.payout_rails?.length ? ` (${c.payout_rails.join("/")})` : ""}` : "";
      return `${c.id} · ${c.name}${pays} · ${c.kinds.join("/")} · ${c.stages.join(", ")} · ${auth}${optIn}\n  ${c.description}`;
    })
    .join("\n");
}

function partialText(partial: PartialFailure[]): string[] {
  return partial.map((p) => `${p.connector} failed: ${p.error.code}: ${p.error.message}`);
}

// ---- results ----

function ok(structured: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function fail(error: unknown): CallToolResult {
  const err = error instanceof ProtocolError ? error : toProtocolError(error);
  const structured = err.toJSON();
  const extra = err.details && Object.keys(err.details).length ? ` ${JSON.stringify(err.details)}` : "";
  return { isError: true, content: [{ type: "text", text: `${err.code}: ${err.message}${extra}` }], structuredContent: structured };
}

async function attempt(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return fail(error);
  }
}

const summaryOf = (job: Job): Job => {
  const { description: _description, raw: _raw, ...rest } = job;
  return rest as Job;
};

export function createWorkMcpServer(protocol: WorkProtocol, options: WorkMcpServerOptions = {}): McpServer {
  const allowLocalFiles = options.allowLocalFiles === true;
  const server = new McpServer(
    { name: options.name ?? "work-protocol", version: options.version ?? VERSION, title: "Work Protocol: find, apply, do and submit work" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "list_connectors",
    {
      title: "List connectors",
      description:
        "The sources this server can search, what each supports (search, get, apply, upload, submit, status, link, account), whether its key is set, and the profile fields update_profile accepts.",
      inputSchema: {},
      outputSchema: out(z.object({ connectors: z.array(ConnectorInfoSchema) })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      attempt(async () => {
        const connectors = protocol.connectors();
        return ok({ connectors }, renderConnectors(connectors));
      }),
  );

  server.registerTool(
    "search_jobs",
    {
      title: "Search jobs and tasks",
      description:
        "Find work. With no query: the tasks available right now (work done and submitted through this server). With a query (a role, a skill, a kind of work): tasks plus job listings from the boards. Each result's `stages` say what can be done with it here; a listing without apply is applied to on the employer's page (`apply_hint`, `url`). Takes up to 40 s when a board is slow; slow or failing sources are listed in `partial`.",
      inputSchema: {
        query: z.string().max(200).optional().describe("A role, a skill or a kind of work. Leave out to list tasks available now."),
        location: z.string().max(120).optional().describe("City, country or region."),
        remote: z.boolean().optional().describe("true for remote work only."),
        kind: z
          .enum(["task", "listing"])
          .optional()
          .describe(
            "task: work done and submitted through this server. listing: a job posting; its stages say whether it is applied to here or on the employer's page.",
          ),
        category: z
          .enum(CONNECTOR_CATEGORIES)
          .optional()
          .describe(
            "Only sources of one kind: bounty (paid per accepted deliverable), micro_task (clipping, UGC, data work), selling (goods and digital products), competition (prize pools) or job (employer and freelance work).",
          ),
        media: z.array(z.enum(MEDIA_KINDS)).optional().describe("For tasks: the media the work is made of."),
        connectors: z.array(z.string()).optional().describe("Connector ids to ask (see list_connectors). Omit for all."),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
        pay_min: z.number().min(0).optional().describe("Minimum compensation/pay amount."),
        currency: z.string().max(16).optional().describe("Currency code filter (e.g., USD, USDC, EUR)."),
        direct_apply: z.boolean().optional().describe("true to only return jobs that support direct application through this protocol."),
        posted_after: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}/u)
          .optional()
          .describe(
            "Only work posted on or after this date (YYYY-MM-DD), e.g. the 1st of this month. Work with no posting date counts while its closing date is ahead; standing programs with no dates are left out. Words like 'this month' in query do the same.",
          ),
      },
      outputSchema: out(
        z.object({ jobs: z.array(JobSummarySchema), count: z.number(), more: z.boolean(), partial: z.array(PartialFailureSchema) }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      attempt(async () => {
        const result = await protocol.search(args);
        const jobs = result.jobs.map(summaryOf);
        const lines = jobs.length
          ? jobs.map(renderJobLine)
          : ["No matches. Try other words, drop the location, or search with no query to list tasks available now."];
        if (result.more) lines.push("", "There is more: narrow the search or raise the limit.");
        lines.push(...partialText(result.partial));
        return ok({ jobs, count: jobs.length, more: result.more, partial: result.partial }, lines.join("\n"));
      }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get a job or task",
      description:
        "The full job: description, and for a task its questions, the files or text it needs, how-to, rules and material. Tasks are fetched live; listings come from the recent search cache.",
      inputSchema: { job_id: z.string().describe("An id from search_jobs, like kariaa:3f2a… or remotive:1923456.") },
      outputSchema: JobOut,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ job_id }) =>
      attempt(async () => {
        const job = await protocol.get(job_id);
        return ok(job, renderJob(job));
      }),
  );

  server.registerTool(
    "apply_to_job",
    {
      title: "Apply to a task",
      description:
        "Apply to a job. Answer its questions by id; choice answers take the option text or its number. Applying twice returns the existing application. Works for any job whose stages include apply: tasks, and listings on boards that take applications here. For other listings the result says where to apply.",
      inputSchema: {
        job_id: z.string(),
        answers: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe("Answers by question id from get_job."),
        note: z.string().max(2000).optional().describe("A note for the reviewer."),
        preferred_rate: z.string().max(80).optional().describe("The rate the person would like for the paid work, in their words."),
      },
      outputSchema: ApplicationOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id, ...input }) =>
      attempt(async () => {
        const application = await protocol.apply(job_id, input);
        return ok(application, renderApplication(application));
      }),
  );

  server.registerTool(
    "add_work",
    {
      title: "Add work to an application",
      description: `Send one piece of work: \`text\` for a written answer, or \`file\` with \`url\` (https, public), \`base64\` (small files, under 1 MB)${allowLocalFiles ? " or `path` (a file on this machine)" : ""}. Call once per sample until progress.ready_to_submit. A duplicate file answers already_exists; carry on.`,
      inputSchema: {
        application_id: z.string(),
        text: z.string().optional().describe("A written answer or sample."),
        file: z
          .object({
            path: z
              .string()
              .optional()
              .describe(allowLocalFiles ? "Path on this machine." : "Not accepted by this server."),
            url: z.string().optional().describe("A public https URL of the file."),
            base64: z.string().optional().describe("The file's bytes in base64 (small files)."),
            name: z.string().max(200).optional().describe("File name with extension, like clip1.mp4. Needed with base64."),
            mime_type: z.string().max(100).optional().describe("Like video/mp4. Detected when left out."),
          })
          .optional(),
      },
      outputSchema: ReceiptOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ application_id, ...work }) =>
      attempt(async () => {
        const receipt = await protocol.upload(application_id, work);
        return ok(receipt, renderReceipt(receipt));
      }),
  );

  server.registerTool(
    "remove_work",
    {
      title: "Remove a piece of work",
      description: "Take back one file added with add_work, before submitting.",
      inputSchema: { application_id: z.string(), file_id: z.string().describe("The file id from add_work or get_application.") },
      outputSchema: ReceiptOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ application_id, file_id }) =>
      attempt(async () => {
        const receipt = await protocol.remove(application_id, file_id);
        return ok(receipt, renderReceipt(receipt));
      }),
  );

  server.registerTool(
    "submit_work",
    {
      title: "Submit the work",
      description:
        "Submit an application's work for review once enough is in (progress.ready_to_submit). Submitting again returns the current state.",
      inputSchema: { application_id: z.string(), note: z.string().max(5000).optional().describe("A note to go with the submission.") },
      outputSchema: ApplicationOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ application_id, note }) =>
      attempt(async () => {
        const application = await protocol.submit(application_id, { note });
        return ok(application, renderApplication(application));
      }),
  );

  server.registerTool(
    "get_application",
    {
      title: "Get an application",
      description: "Where an application stands: stage, files in, progress, the review outcome and what to do next.",
      inputSchema: { application_id: z.string() },
      outputSchema: ApplicationOut,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ application_id }) =>
      attempt(async () => {
        const application = await protocol.status(application_id);
        return ok(application, renderApplication(application));
      }),
  );

  server.registerTool(
    "my_applications",
    {
      title: "My applications",
      description: "Every application the signed-in accounts have, across connectors or for one.",
      inputSchema: { connector: z.string().optional().describe("A connector id to limit to.") },
      outputSchema: out(z.object({ applications: z.array(ApplicationItem), count: z.number(), partial: z.array(PartialFailureSchema) })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ connector }) =>
      attempt(async () => {
        const result = await protocol.list(connector);
        const lines = result.applications.length ? result.applications.map(renderApplication) : ["No applications yet."];
        lines.push(...partialText(result.partial));
        return ok({ applications: result.applications, count: result.applications.length, partial: result.partial }, lines.join("\n\n"));
      }),
  );

  server.registerTool(
    "get_work_link",
    {
      title: "Get a web link to finish the work",
      description:
        "A link where the person finishes the application in a browser (for media on their phone, for example). Kariaa links sign them in and expire after 15 minutes.",
      inputSchema: { application_id: z.string() },
      outputSchema: out(LinkSchema.extend({ application_id: z.string() })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ application_id }) =>
      attempt(async () => {
        const link = await protocol.link(application_id);
        return ok({ application_id, ...link }, `${link.url}${link.expires_at ? `\nExpires ${link.expires_at}` : ""}`);
      }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "For each connector with an account: whether it is signed in, whether the profile is ready to apply, what is missing, and today's usage.",
      inputSchema: {},
      outputSchema: out(z.object({ accounts: z.array(AccountItem) })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      attempt(async () => {
        const accounts = await protocol.accounts();
        return ok({ accounts }, accounts.length ? accounts.map(renderAccount).join("\n") : "No connector here keeps an account.");
      }),
  );

  server.registerTool(
    "connect_account",
    {
      title: "Connect an account",
      description:
        "Get onto a platform. Already connected: the account. On platforms whose own API lets agents sign up (NEAR Agent Market, Superteam Earn), pass the owner's email and it registers an agent account and keeps the key; the owner gets an email to claim it. Elsewhere: the exact steps, the page where the person creates the key or signs in, and the fields save_credentials takes. Leave connector out to see every platform's state. Ask the person before registering.",
      inputSchema: {
        connector: z.string().optional().describe("Connector id, like near-agent-market. Leave out for all."),
        email: z.string().max(200).optional().describe("The owner's email, to register where the platform allows it."),
        name: z.string().max(80).optional().describe("Display name for a new agent account."),
        handle: z.string().max(60).optional().describe("Handle for a new agent account: lowercase letters, digits and dashes."),
        description: z.string().max(500).optional().describe("What the agent does, for a new account."),
      },
      outputSchema: out(z.object({ connections: z.array(ConnectionSchema) })),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ connector, ...input }) =>
      attempt(async () => {
        const connections = connector ? [await protocol.connect(connector, input)] : await protocol.connections();
        return ok({ connections }, connections.map(renderConnection).join("\n\n"));
      }),
  );

  server.registerTool(
    "save_credentials",
    {
      title: "Save credentials",
      description:
        "Keep a key or token the person gave you for one platform. It is checked against the platform first and refused if the platform refuses it. connect_account names the fields for each platform.",
      inputSchema: {
        connector: z.string().describe("Connector id, like whop-bounties."),
        values: z
          .record(z.string(), z.string().max(4000))
          .describe('Credential values by the names connect_account lists, like { WHOP_OAUTH_TOKEN: "…" }.'),
      },
      outputSchema: out(ConnectionSchema),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connector, values }) =>
      attempt(async () => {
        const connection = await protocol.saveCredentials(connector, values);
        return ok(connection, renderConnection(connection));
      }),
  );

  server.registerTool(
    "update_profile",
    {
      title: "Update a profile",
      description:
        "Set profile fields on one connector's account. list_connectors names the accepted fields (for Kariaa: legal_first_name, legal_last_name, phone_number, location, occupation, language, email).",
      inputSchema: {
        connector: z.string().describe("Connector id, like kariaa."),
        fields: z.record(z.string(), z.unknown()).describe("Field values by name."),
      },
      outputSchema: AccountOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ connector, fields }) =>
      attempt(async () => {
        const account = { connector, ...(await protocol.updateAccount(connector, fields)) };
        return ok(account, renderAccount(account));
      }),
  );

  server.registerTool(
    "my_earnings",
    {
      title: "My earnings",
      description:
        "What the person has earned on each connector: balance, pending credits, each accepted piece of work, payouts so far, and how a payout works (minimum, methods).",
      inputSchema: { connector: z.string().optional().describe("A connector id to limit to.") },
      outputSchema: out(z.object({ earnings: z.array(EarningsItem), partial: z.array(PartialFailureSchema) })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ connector }) =>
      attempt(async () => {
        const result = await protocol.earnings(connector);
        const lines = result.earnings.length ? result.earnings.map(renderEarnings) : ["No connector here reports earnings."];
        lines.push(...partialText(result.partial));
        return ok({ earnings: result.earnings, partial: result.partial }, lines.join("\n"));
      }),
  );

  server.registerTool(
    "request_payout",
    {
      title: "Request a payout",
      description:
        "Ask one connector to pay out earnings. Leave `amount` out for the whole available balance. `method` and `destination` must be ones my_earnings lists for that connector; the person confirms before you call this.",
      inputSchema: {
        connector: z.string().describe("Connector id, like kariaa."),
        amount: z.number().positive().optional().describe("Leave out for the whole available balance."),
        method: z.string().min(1).max(40).describe("A method from my_earnings, like paypal."),
        destination: z.string().max(200).optional().describe("Where it goes: an email, a handle, an account."),
        note: z.string().max(1000).optional(),
      },
      outputSchema: PayoutOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ connector, ...input }) =>
      attempt(async () => {
        const payout = await protocol.requestPayout(connector, input);
        return ok(payout, renderPayout(payout));
      }),
  );

  // ---- giving work out ----

  const MoneyIn = z.object({ amount: z.number().positive(), currency: z.string().min(1).max(20) });
  const PostingOut = out(PostingSchema);
  const PaymentOut = out(PaymentSchema);

  server.registerTool(
    "post_job",
    {
      title: "Post a job for someone else to do",
      description:
        "Post work on one platform for a person or another agent to do. Say exactly what is wanted and how it will be judged (acceptance). Posting pays nothing: money is set aside and released with pay_for_work, each after a confirm step. The person you act for decides the budget; ask before posting.",
      inputSchema: {
        connector: z.string().describe("The platform to post on: one whose stages include post (see list_connectors)."),
        title: z.string().min(3).max(200),
        description: z.string().min(10).max(20_000).describe("What is wanted, in full: inputs, the deliverable, its format."),
        budget: MoneyIn.describe("The most you will pay, like { amount: 30, currency: 'USD' }."),
        acceptance: z.array(z.string().max(500)).max(20).optional().describe("How the work will be judged, one line each."),
        skills: z.array(z.string().max(60)).max(20).optional(),
        workers: z.enum(WORKER_KINDS).optional().describe("Who should do it: human, agent or any."),
        deadline: z.string().max(40).optional().describe("ISO date the work is due."),
        answers: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe("What this platform needs beyond the above."),
      },
      outputSchema: PostingOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ connector, ...input }) =>
      attempt(async () => {
        const posting = await protocol.post(connector, input);
        return ok(posting, renderPosting(posting));
      }),
  );

  server.registerTool(
    "my_postings",
    {
      title: "Jobs I posted",
      description:
        "The jobs you posted and where each stands: open, assigned, in review, completed or cancelled, and whether the money is set aside.",
      inputSchema: { connector: z.string().optional().describe("A connector id to limit to.") },
      outputSchema: out(z.object({ postings: z.array(PostingSchema), count: z.number(), partial: z.array(PartialFailureSchema) })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connector }) =>
      attempt(async () => {
        const result = await protocol.postings(connector);
        const lines = result.postings.length ? result.postings.map(renderPosting) : ["Nothing posted yet."];
        lines.push(...partialText(result.partial));
        return ok({ postings: result.postings, count: result.postings.length, partial: result.partial }, lines.join("\n\n"));
      }),
  );

  server.registerTool(
    "list_offers",
    {
      title: "Offers on a job I posted",
      description:
        "One posting with every bid, application or entry on it: who it is from, their price and time, what they wrote, and what they delivered once they have. Read all of them before awarding.",
      inputSchema: { posting_id: z.string().describe("An id from post_job or my_postings.") },
      outputSchema: out(z.object({ posting: PostingSchema, offers: z.array(OfferSchema), count: z.number() })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ posting_id }) =>
      attempt(async () => {
        const result = await protocol.offers(posting_id);
        const lines = [renderPosting(result.posting), "", ...(result.offers.length ? result.offers.map(renderOffer) : ["No offers yet."])];
        return ok({ posting: result.posting, offers: result.offers, count: result.offers.length }, lines.join("\n"));
      }),
  );

  server.registerTool(
    "award_offer",
    {
      title: "Pick an offer",
      description: "Give the work to one offer. The person you act for chooses; ask before awarding. Awarding pays nothing by itself.",
      inputSchema: { posting_id: z.string(), offer_id: z.string().describe("An offer id from list_offers.") },
      outputSchema: PostingOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ posting_id, offer_id }) =>
      attempt(async () => {
        const posting = await protocol.award(posting_id, offer_id);
        return ok(posting, renderPosting(posting));
      }),
  );

  server.registerTool(
    "review_work",
    {
      title: "Review delivered work",
      description:
        "Judge what was handed in against what the posting asked for: accept, request_changes (say exactly what to change) or reject (say why). Accepting does not pay; pay_for_work does.",
      inputSchema: {
        posting_id: z.string(),
        decision: z.enum(["accept", "request_changes", "reject"]),
        note: z.string().max(5000).optional().describe("Required unless accepting."),
      },
      outputSchema: PostingOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ posting_id, ...input }) =>
      attempt(async () => {
        const posting = await protocol.review(posting_id, input);
        return ok(posting, renderPosting(posting));
      }),
  );

  server.registerTool(
    "pay_for_work",
    {
      title: "Set money aside or release it",
      description:
        "Money for a posting, always in two calls. The first call moves nothing: it answers confirm_needed with the amount, the fee, who receives it and a confirm token. Show that to the person you act for. Only when they agree, call again with the same terms and confirm set to the token. action fund sets the money aside; release hands it over.",
      inputSchema: {
        posting_id: z.string(),
        action: z.enum(["fund", "release"]).optional().describe("Left out: whichever the posting needs next."),
        offer_id: z.string().optional().describe("The offer being paid. Left out: the awarded one."),
        amount: MoneyIn.optional().describe("Left out: what the platform says is owed."),
        note: z.string().max(1000).optional(),
        confirm: z.string().max(200).optional().describe("The token from the first call, once the person has agreed."),
      },
      outputSchema: PaymentOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ posting_id, offer_id, ...input }) =>
      attempt(async () => {
        const payment = await protocol.pay(posting_id, { ...input, ...(offer_id ? { offer: offer_id } : {}) });
        return ok(payment, renderPayment(payment));
      }),
  );

  server.registerTool(
    "cancel_posting",
    {
      title: "Cancel a job I posted",
      description: "Close a posting. The result says what happens to money already set aside. Ask the person you act for first.",
      inputSchema: { posting_id: z.string(), note: z.string().max(1000).optional() },
      outputSchema: PostingOut,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ posting_id, note }) =>
      attempt(async () => {
        const posting = await protocol.cancelPosting(posting_id, note ? { note } : {});
        return ok(posting, renderPosting(posting));
      }),
  );

  server.registerTool(
    "verify_work",
    {
      title: "Verify work before sending it",
      description:
        "Checks work against a task's requirements with deterministic verifiers, before add_work: enough pieces, the right kinds, clip length, image size, no duplicates, written answers that read as answers. Answers pass, fail or uncertain with every check, and what the task would pay for the accepted pieces. Nothing is sent anywhere.",
      inputSchema: {
        job_id: z.string(),
        work: z
          .array(z.object({ text: z.string().optional(), file: FileInput.optional() }))
          .max(20)
          .default([])
          .describe(
            "The pieces as you would send them to add_work: text, or file with url / base64" +
              (allowLocalFiles ? " / path" : "") +
              ". Optional when verifying only screening answers.",
          ),
        answers: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe("Answers by question id, to check required questions and options."),
      },
      outputSchema: VerificationOut,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id, work, answers }) =>
      attempt(async () => {
        const verification = await protocol.verify(job_id, work, answers);
        return ok(verification, renderVerification(verification));
      }),
  );

  server.registerResource(
    "guide",
    GUIDE_URI,
    { title: "Work Protocol guide", description: "How to find, apply, do and submit work with these tools.", mimeType: "text/markdown" },
    async () => ({
      contents: [{ uri: GUIDE_URI, mimeType: "text/markdown", text: GUIDE_MARKDOWN }],
    }),
  );

  server.registerPrompt(
    "find-work",
    {
      title: "Find work",
      description: "Find tasks to do now and job listings for a role and place, then walk through one.",
      argsSchema: { role: z.string().optional(), location: z.string().optional() },
    },
    ({ role, location }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Find me work.",
              role ? `Role or skill: ${role}.` : "Start with the tasks available right now (search_jobs with no query).",
              location ? `Place: ${location}.` : "",
              "Show what you find with ids, then for a task I pick: read it with get_job, help me answer its questions, apply, add the work, and submit.",
            ]
              .filter(Boolean)
              .join(" "),
          },
        },
      ],
    }),
  );

  return server;
}
