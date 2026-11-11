/**
 * An in-memory stand-in for Kariaa's MCP server with the tools and result
 * shapes the connector relies on.
 * State is shared across connections; each connection gets its own McpServer.
 */
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { TransportFactory } from "../../src/connectors/kariaa/client.js";

type Rec = Record<string, unknown>;

export const TASK_AUDIO = "11111111-1111-4111-8111-111111111111";
export const TASK_TEXT = "22222222-2222-4222-8222-222222222222";
export const TASK_LOCKED = "33333333-3333-4333-8333-333333333333";
export const JOB_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const JOB_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const PROGRAM_RULES = ["Your own recordings only.", "No faces of other people without consent."];

type Question = { id: string; question: string; type: string; options: string[] | null; required: boolean };
type Task = {
  task_id: string;
  title: string;
  summary: string;
  instructions: string | null;
  category: string;
  pay: { amount: number; currency: string; unit: string } | null;
  pay_note: string;
  rules: string[];
  program_rules: string[];
  pay_display: string | null;
  pricing_note: string | null;
  allowed_file_kinds: string[];
  sample: {
    count: number;
    max_duration_seconds: number | null;
    instructions: string;
    example_idea: null;
    how_to: string[];
    looks_like: string;
    paid: false;
  } | null;
  qualification_questions: Question[];
  end_date: string;
  url: string;
};
type JobRow = {
  job_id: string;
  title: string;
  company: string;
  location: string;
  work_type: string | null;
  pay: string | null;
  posted: string;
  url: string;
  source: string;
  match: string;
  description: string;
  requirements: string | null;
  how_to_apply: string;
};

const TASKS: Task[] = [
  {
    task_id: TASK_AUDIO,
    title: "Read Sentences Aloud in Your Language",
    summary: "Record yourself reading short sentences in a quiet room.",
    instructions: "1. The cat sat on the mat.\n2. Rain is expected tomorrow.",
    category: "voice",
    pay: { amount: 0.5, currency: "USD", unit: "per clip" },
    pay_note: "The rate for paid work after verification. The samples themselves are unpaid.",
    rules: ["Read every sentence once."],
    program_rules: PROGRAM_RULES,
    pay_display: "USD 0.5 per clip",
    pricing_note: null,
    allowed_file_kinds: ["audio"],
    sample: {
      count: 2,
      max_duration_seconds: 30,
      instructions: "Two clips of up to 30 seconds.",
      example_idea: null,
      how_to: ["Open the voice recorder", "Read at a natural pace"],
      looks_like: "Clear speech, no music.",
      paid: false,
    },
    qualification_questions: [
      {
        id: "language",
        question: "Which language will you read in?",
        type: "select",
        options: ["English", "Twi", "French"],
        required: true,
      },
      { id: "mic", question: "What will you record with?", type: "text", options: null, required: false },
    ],
    end_date: "2099-12-31",
    url: `https://www.kariaa.com/go/${TASK_AUDIO}`,
  },
  {
    task_id: TASK_TEXT,
    title: "Label Short Texts",
    summary: "Read short texts and pick the label that fits.",
    instructions: "Text A: 'Great service, will come back.' Labels: positive, negative, neutral.",
    category: "text",
    pay: { amount: 2, currency: "USD", unit: "per task" },
    pay_note: "The rate for paid work after verification. The samples themselves are unpaid.",
    rules: [],
    program_rules: PROGRAM_RULES,
    pay_display: "USD 2 per task",
    pricing_note: null,
    allowed_file_kinds: ["text"],
    sample: {
      count: 1,
      max_duration_seconds: null,
      instructions: "Label the text and say why.",
      example_idea: null,
      how_to: ["Read the text twice"],
      looks_like: "One label and one sentence of reasoning.",
      paid: false,
    },
    qualification_questions: [],
    end_date: "2099-12-31",
    url: `https://www.kariaa.com/go/${TASK_TEXT}`,
  },
  {
    task_id: TASK_LOCKED,
    title: "Data Labeler & Annotator",
    summary: "Ongoing labeling work; the team unlocks it after a look at your profile.",
    instructions: null,
    category: "text",
    pay: null,
    pay_note: "The rate for paid work after verification. The samples themselves are unpaid.",
    rules: [],
    program_rules: PROGRAM_RULES,
    pay_display: null,
    pricing_note: "an agreed rate",
    allowed_file_kinds: ["text"],
    sample: null,
    qualification_questions: [],
    end_date: "2099-12-31",
    url: `https://www.kariaa.com/go/${TASK_LOCKED}`,
  },
];

const JOBS: JobRow[] = [
  {
    job_id: JOB_ONE,
    title: "Electrician",
    company: "Accra Power Ltd",
    location: "Accra, Ghana",
    work_type: null,
    pay: "GHS 3,000 per month",
    posted: "2026-10-16T08:00:00.000Z",
    url: "https://www.jobberman.com.gh/listings/electrician-1",
    source: "jobberman",
    match: "exact",
    description: "Install and maintain wiring in residential buildings.",
    requirements: "Certificate in electrical installation. 2 years experience.",
    how_to_apply: "Apply on the employer's page at the url.",
  },
  {
    job_id: JOB_TWO,
    title: "Electrical technician",
    company: "Volt Services",
    location: "Lagos, Nigeria",
    work_type: "Remote",
    pay: null,
    posted: "2026-10-15T08:00:00.000Z",
    url: "https://ng.indeed.com/viewjob?jk=abc",
    source: "indeed",
    match: "related",
    description: "Support remote diagnostics for industrial clients.",
    requirements: null,
    how_to_apply: "Apply on the employer's page at the url.",
  },
];

type Staged = { id: string; path: string; name: string; size: number; type: string; kind: string; fingerprint: string };
type Submission = {
  submission_id: string;
  task_id: string;
  stage: "pending_review" | "sample_needed" | "in_review";
  staged: Staged[];
  answers: Rec;
  preferred_rate: string | null;
  applied_at: string;
  submitted_at: string | null;
  text_response: string | null;
};

export type FakeKariaaState = {
  submissions: Map<string, Submission>;
  slots: Map<string, { submission_id: string; mime: string; size: number; url: string; path: string }>;
  objects: Map<string, Uint8Array>;
  profile: {
    legal_first_name: string | null;
    legal_last_name: string | null;
    phone_number: string | null;
    location: string | null;
    occupation: string[];
    email: string | null;
    language: string | null;
  };
  calls: string[];
  connections: number;
  usage: { calls: number; writes: number };
  ledger: { balance: number; total: number; entries: Rec[]; payouts: Rec[] };
};

export function createFakeKariaa(options: { profileComplete?: boolean; earnings?: boolean } = {}) {
  const state: FakeKariaaState = {
    submissions: new Map(),
    slots: new Map(),
    objects: new Map(),
    profile:
      options.profileComplete === false
        ? { legal_first_name: null, legal_last_name: null, phone_number: null, location: null, occupation: [], email: null, language: null }
        : {
            legal_first_name: "Ama",
            legal_last_name: "Mensah",
            phone_number: "+233201234567",
            location: "Accra, Ghana",
            occupation: ["Electrician"],
            email: "ama@example.com",
            language: "English",
          },
    calls: [],
    connections: 0,
    usage: { calls: 0, writes: 0 },
    ledger: {
      balance: 12.5,
      total: 13,
      entries: [
        {
          id: "earn-1",
          submission_id: "00000099-0000-4000-8000-000000000000",
          task_title: "Read Sentences Aloud in Your Language",
          amount: 12.5,
          currency: "USD",
          status: "available",
          earned_at: "2026-10-10T12:00:00.000Z",
        },
        {
          id: "earn-0",
          submission_id: "00000098-0000-4000-8000-000000000000",
          task_title: "Label Short Texts",
          amount: 0.5,
          currency: "USD",
          status: "paid",
          earned_at: "2026-09-30T12:00:00.000Z",
        },
      ],
      payouts: [
        {
          payout_id: "pay-0",
          amount: 0.5,
          currency: "USD",
          method: "paypal",
          status: "paid",
          requested_at: "2026-10-01T00:00:00.000Z",
          paid_at: "2026-10-02T00:00:00.000Z",
        },
      ],
    },
  };
  let seq = 0;
  const uuid = () => {
    seq += 1;
    return `${String(seq).padStart(8, "0")}-0000-4000-8000-000000000000`;
  };
  const missingBasics = () => {
    const p = state.profile;
    const missing: string[] = [];
    if (!p.legal_first_name || !p.legal_last_name) missing.push("legal_name");
    if (!p.phone_number) missing.push("phone_number");
    if (!p.location) missing.push("location");
    if (!p.occupation.length) missing.push("occupation");
    return missing;
  };

  const ok = (structured: Rec, text = "ok"): CallToolResult => ({ content: [{ type: "text", text }], structuredContent: structured });
  const fail = (code: string, message: string, extra: Rec = {}): CallToolResult => ({
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: code, message, ...extra },
  });

  const shapeSubmission = (s: Submission): Rec => {
    const task = TASKS.find((t) => t.task_id === s.task_id)!;
    const sample = task.sample;
    const wanted = sample ? Number(sample.count ?? 1) : 0;
    const stage = s.stage;
    return {
      submission_id: s.submission_id,
      task_id: s.task_id,
      task_title: task.title,
      applied_at: s.applied_at,
      stage,
      staged_files: s.staged.map((f) => ({ id: f.id, name: f.name, kind: f.kind, size: f.size })),
      received: s.staged.length,
      wanted: wanted || null,
      ready_to_submit: stage === "sample_needed" && (wanted <= 1 ? s.staged.length >= 1 : s.staged.length >= wanted),
      review: s.submitted_at
        ? {
            status: "submitted",
            review_note: null,
            earned_amount: null,
            earned_currency: null,
            submitted_at: s.submitted_at,
            reviewed_at: null,
            files_count: s.staged.length,
          }
        : null,
      preferred_rate: s.preferred_rate,
      next:
        stage === "sample_needed"
          ? "Upload samples, then submit_samples."
          : stage === "pending_review"
            ? "The team unlocks this task before samples can be sent; check back with get_submission."
            : "Submitted. The team reviews it; check get_submission for the outcome.",
    };
  };
  const progress = (s: Submission): Rec => {
    const task = TASKS.find((t) => t.task_id === s.task_id)!;
    const wanted = Number(task.sample?.count ?? 0) || 1;
    return {
      received: s.staged.length,
      wanted,
      remaining: Math.max(0, wanted - s.staged.length),
      ready_to_submit: s.staged.length >= wanted,
      staged_files: s.staged.map((f) => ({ id: f.id, name: f.name, kind: f.kind, size: f.size })),
    };
  };

  function buildServer(signedIn: boolean): McpServer {
    const server = new McpServer({ name: "kariaa-datahouse-fake", version: "1.1.0" });
    const requireUser = (): CallToolResult | null => (signedIn ? null : fail("sign_in_required", "This needs the person signed in."));
    const mine = (id: string): Submission | undefined => state.submissions.get(id);
    const notFound = (): CallToolResult => fail("submission_not_found", "No submission with that id belongs to this account.");
    const tool = (name: string, shape: z.ZodRawShape, handler: (args: Rec) => CallToolResult | Promise<CallToolResult>) => {
      server.registerTool(name, { inputSchema: shape }, async (args) => {
        state.calls.push(name);
        state.usage.calls += 1;
        return handler(args as Rec);
      });
    };

    tool(
      "list_tasks",
      { kind: z.enum(["image", "video", "audio", "text"]).optional(), limit: z.number().int().min(1).max(50).optional() },
      (args) => {
        const tasks = TASKS.filter((t) => !args.kind || t.allowed_file_kinds.includes(args.kind as string)).slice(
          0,
          Number(args.limit ?? 25),
        );
        return ok({ tasks, count: tasks.length, signed_in: signedIn });
      },
    );
    tool("get_task", { task_id: z.string().uuid() }, (args) => {
      const task = TASKS.find((t) => t.task_id === args.task_id);
      return task
        ? ok({ ...task, next: signedIn ? "apply_to_task" : "sign_in_first" })
        : fail("task_not_found", "No open DataHouse task has that id.");
    });
    tool("whoami", {}, () => {
      if (!signedIn) return ok({ signed_in: false, how_to_sign_in: "Send a Kariaa API key as Authorization: Bearer kra_…" });
      const missing = missingBasics();
      const p = state.profile;
      return ok({
        signed_in: true,
        user_id: "user-1",
        key: { label: "test key" },
        profile: {
          legal_name: [p.legal_first_name, p.legal_last_name].filter(Boolean).join(" ") || null,
          phone_number: p.phone_number ? "+233•••4567" : null,
          location: p.location,
          occupation: p.occupation,
          email: p.email,
          language: p.language,
        },
        ready_to_apply: missing.length === 0,
        missing,
        quota: { calls_today: state.usage.calls, calls_max: 2000, writes_today: state.usage.writes, writes_max: 60 },
      });
    });
    tool(
      "update_profile",
      {
        legal_first_name: z.string().optional(),
        legal_last_name: z.string().optional(),
        phone_number: z.string().optional(),
        location: z.string().optional(),
        occupation: z.array(z.string()).optional(),
        language: z.string().optional(),
        email: z.string().optional(),
      },
      (args) => {
        const gate = requireUser();
        if (gate) return gate;
        state.usage.writes += 1;
        const saved: string[] = [];
        const rejected: Rec[] = [];
        for (const [field, value] of Object.entries(args)) {
          if (value === undefined) continue;
          if (field === "phone_number" && !/^\+\d{7,}$/u.test(String(value))) {
            rejected.push({ field, reason: "Use the international format, like +233201234567." });
            continue;
          }
          (state.profile as Rec)[field] = value;
          saved.push(field);
        }
        const missing = missingBasics();
        return ok({ saved, rejected, ready_to_apply: missing.length === 0, missing });
      },
    );
    tool(
      "apply_to_task",
      {
        task_id: z.string().uuid(),
        answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        preferred_rate: z.string().optional(),
        note: z.string().optional(),
      },
      (args) => {
        const gate = requireUser();
        if (gate) return gate;
        const task = TASKS.find((t) => t.task_id === args.task_id);
        if (!task) return fail("task_not_found", "No open DataHouse task has that id.");
        const questions = task.qualification_questions;
        const raw = (args.answers ?? {}) as Record<string, string | string[]>;
        const invalid: Rec[] = [];
        for (const q of questions) {
          const given = raw[q.id];
          if (given === undefined) continue;
          const options = q.options ?? [];
          if (options.length && typeof given === "string" && !options.includes(given) && !/^\d{1,2}$/u.test(given))
            invalid.push({ id: q.id, given, options });
        }
        if (invalid.length) return fail("answer_not_an_option", "An answer is not one of the options.", { invalid });
        const missing = questions.filter((q) => q.required && raw[q.id] === undefined).map((q) => q.id);
        if (missing.length) return fail("answers_missing", "Answer the required questions first.", { question_ids: missing });
        const basics = missingBasics();
        if (basics.length) return fail("profile_incomplete", "Complete the profile first.", { missing: basics });
        const ignored = Object.keys(raw).filter((k) => !questions.some((q) => q.id === k));
        const existing = [...state.submissions.values()].find((s) => s.task_id === task.task_id);
        if (existing) return ok({ already_applied: true, submission_id: existing.submission_id, stage: existing.stage });
        state.usage.writes += 1;
        const submission: Submission = {
          submission_id: uuid(),
          task_id: task.task_id,
          stage: task.sample ? "sample_needed" : "pending_review",
          staged: [],
          answers: raw,
          preferred_rate: typeof args.preferred_rate === "string" ? args.preferred_rate : null,
          applied_at: new Date().toISOString(),
          submitted_at: null,
          text_response: null,
        };
        state.submissions.set(submission.submission_id, submission);
        return ok({
          applied: true,
          submission_id: submission.submission_id,
          task_id: task.task_id,
          stage: submission.stage,
          sample_requirements: task.sample,
          allowed_file_kinds: task.allowed_file_kinds,
          next: submission.stage === "sample_needed" ? "request_upload" : "get_submission",
          ...(ignored.length ? { ignored_answers: ignored } : {}),
        });
      },
    );
    tool(
      "request_upload",
      {
        submission_id: z.string().uuid(),
        filename: z.string().min(1).max(120),
        mime_type: z.string(),
        size_bytes: z
          .number()
          .int()
          .positive()
          .max(100 * 1024 * 1024),
      },
      (args) => {
        const gate = requireUser();
        if (gate) return gate;
        const sub = mine(String(args.submission_id));
        if (!sub) return notFound();
        if (sub.stage === "in_review") return fail("already_submitted", "This submission is already in review.");
        if (sub.stage === "pending_review") return fail("not_unlocked", "The team has not unlocked this task yet.");
        const task = TASKS.find((t) => t.task_id === sub.task_id)!;
        const kinds = task.allowed_file_kinds;
        const mime = String(args.mime_type);
        const kind = mime.startsWith("audio/")
          ? "audio"
          : mime.startsWith("video/")
            ? "video"
            : mime.startsWith("image/")
              ? "image"
              : "text";
        if (!kinds.includes(kind))
          return fail("kind_not_allowed", `This task takes ${kinds.join(", ")} files.`, { allowed_file_kinds: kinds });
        if (sub.staged.length >= 10) return fail("too_many_files", "At most 10 files per task.");
        state.usage.writes += 1;
        const path = `${sub.task_id}/${sub.submission_id}/${Date.now()}-${uuid()}-${args.filename}`;
        const url = `https://storage.fake/${path}`;
        state.slots.set(path, { submission_id: sub.submission_id, mime, size: Number(args.size_bytes), url, path });
        return ok({
          upload_url: url,
          method: "PUT",
          headers: { "Content-Type": mime, "x-upsert": "false" },
          path,
          expires_in_seconds: 7200,
          then: "confirm_upload",
        });
      },
    );
    tool("confirm_upload", { submission_id: z.string().uuid(), path: z.string() }, (args) => {
      const gate = requireUser();
      if (gate) return gate;
      const sub = mine(String(args.submission_id));
      if (!sub) return notFound();
      const slot = state.slots.get(String(args.path));
      if (!slot || slot.submission_id !== sub.submission_id) return fail("path_mismatch", "That path does not belong to this submission.");
      const bytes = state.objects.get(slot.url);
      if (!bytes) return fail("object_not_found", "Nothing was uploaded to that path yet.");
      const already = sub.staged.find((f) => f.path === slot.path);
      if (already)
        return ok({
          file: { id: already.id, path: already.path, name: already.name, size: already.size, type: already.type, kind: already.kind },
          ...progress(sub),
        });
      if (bytes.byteLength < 10) return fail("file_too_small", "The file is too small to be a real sample.");
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      const duplicate = sub.staged.find((f) => f.fingerprint === fingerprint);
      if (duplicate) return fail("duplicate_sample", "This file is already in.", { duplicate_of: duplicate.id });
      state.usage.writes += 1;
      const name = slot.path.split("-").slice(-1)[0] ?? "file";
      const staged: Staged = {
        id: slot.path,
        path: slot.path,
        name,
        size: bytes.byteLength,
        type: slot.mime,
        kind: slot.mime.split("/")[0] ?? "file",
        fingerprint,
      };
      sub.staged.push(staged);
      return ok({
        file: { id: staged.id, path: staged.path, name: staged.name, size: staged.size, type: staged.type, kind: staged.kind },
        ...progress(sub),
      });
    });
    tool(
      "add_text_sample",
      { submission_id: z.string().uuid(), text: z.string().min(20).max(20_000), filename: z.string().optional() },
      (args) => {
        const gate = requireUser();
        if (gate) return gate;
        const sub = mine(String(args.submission_id));
        if (!sub) return notFound();
        if (sub.stage === "in_review") return fail("already_submitted", "This submission is already in review.");
        if (sub.stage === "pending_review") return fail("not_unlocked", "The team has not unlocked this task yet.");
        const task = TASKS.find((t) => t.task_id === sub.task_id)!;
        if (!task.allowed_file_kinds.includes("text")) return fail("text_not_allowed", "This task takes files, not text.");
        if (/^(.)\1{19,}$/u.test(String(args.text))) return fail("looks_like_gibberish", "That does not read like an answer.");
        state.usage.writes += 1;
        const text = String(args.text);
        const staged: Staged = {
          id: `${sub.submission_id}/text-${sub.staged.length + 1}.txt`,
          path: "",
          name: String(args.filename ?? "answer.txt"),
          size: text.length,
          type: "text/plain",
          kind: "text",
          fingerprint: createHash("sha256").update(text).digest("hex"),
        };
        sub.staged.push(staged);
        return ok({ file: { id: staged.id, name: staged.name, size: staged.size, kind: "text" }, ...progress(sub) });
      },
    );
    tool("remove_sample", { submission_id: z.string().uuid(), file_id: z.string() }, (args) => {
      const gate = requireUser();
      if (gate) return gate;
      const sub = mine(String(args.submission_id));
      if (!sub) return notFound();
      if (sub.stage === "in_review") return fail("already_submitted", "This submission is already in review.");
      const index = sub.staged.findIndex((f) => f.id === args.file_id);
      if (index < 0) return fail("sample_not_found", "No staged file has that id.");
      const [removed] = sub.staged.splice(index, 1);
      return ok({ removed: { id: removed!.id, name: removed!.name }, ...progress(sub) });
    });
    tool("submit_samples", { submission_id: z.string().uuid(), text_response: z.string().optional() }, (args) => {
      const gate = requireUser();
      if (gate) return gate;
      const sub = mine(String(args.submission_id));
      if (!sub) return notFound();
      if (sub.stage === "in_review") return fail("already_submitted", "This submission is already in review.");
      const p = progress(sub);
      if (!p.ready_to_submit)
        return fail("not_enough_files", `${p.received} of ${p.wanted} samples are in.`, { received: p.received, wanted: p.wanted });
      state.usage.writes += 1;
      sub.stage = "in_review";
      sub.submitted_at = new Date().toISOString();
      sub.text_response = typeof args.text_response === "string" ? args.text_response : null;
      return ok({ submitted: true, status: "submitted", files_count: sub.staged.length, submitted_at: sub.submitted_at });
    });
    tool("get_submission", { submission_id: z.string().uuid() }, (args) => {
      const gate = requireUser();
      if (gate) return gate;
      const sub = mine(String(args.submission_id));
      if (!sub) return notFound();
      return ok(shapeSubmission(sub));
    });
    tool("my_submissions", { limit: z.number().int().optional() }, () => {
      const gate = requireUser();
      if (gate) return gate;
      return ok({ submissions: [...state.submissions.values()].map(shapeSubmission) });
    });
    tool("get_upload_link", { submission_id: z.string().uuid() }, (args) => {
      const gate = requireUser();
      if (gate) return gate;
      const sub = mine(String(args.submission_id));
      if (!sub) return notFound();
      if (sub.stage === "in_review") return fail("already_submitted", "This submission is already in review.");
      return ok({ url: `https://www.kariaa.com/auth/magic?token=fake-${sub.submission_id}`, signed_in: true, expires_in_minutes: 15 });
    });
    tool(
      "search_jobs",
      {
        role: z.string().min(2).max(80),
        location: z.string().min(2).max(120).optional(),
        remote: z.boolean().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
      (args) => {
        const role = String(args.role).toLowerCase();
        const rows = JOBS.filter((j) => j.title.toLowerCase().includes(role.slice(0, 5))).map(
          ({ description: _d, requirements: _r, how_to_apply: _h, ...row }) => row,
        );
        return ok({
          jobs: rows.slice(0, Number(args.limit ?? 10)),
          count: rows.length,
          role: args.role,
          location: args.location ?? null,
          more_pending: true,
        });
      },
    );
    tool("get_job", { job_id: z.string().uuid() }, (args) => {
      const job = JOBS.find((j) => j.job_id === args.job_id);
      if (!job) return fail("job_not_found", "No job has that id.");
      const { match: _m, ...rest } = job;
      return ok({ ...rest, description_is_partial: false });
    });
    if (options.earnings !== false) {
      // The contract proposed for Kariaa's server (src/connectors/kariaa/README.md).
      tool("my_earnings", {}, () => {
        const gate = requireUser();
        if (gate) return gate;
        const l = state.ledger;
        return ok({
          balance: { amount: l.balance, currency: "USD" },
          total_earned: { amount: l.total, currency: "USD" },
          pending: { amount: 0, currency: "USD" },
          entries: l.entries,
          payouts: l.payouts,
          min_payout: { amount: 10, currency: "USD" },
          methods: ["paypal", "venmo", "giftcard"],
        });
      });
      tool(
        "request_payout",
        { amount: z.number().positive().optional(), method: z.string(), destination: z.string().optional(), note: z.string().optional() },
        (args) => {
          const gate = requireUser();
          if (gate) return gate;
          const l = state.ledger;
          const methods = ["paypal", "venmo", "giftcard"];
          if (!methods.includes(String(args.method)))
            return fail("method_not_supported", "Pick a payout method Kariaa supports.", { methods });
          if (!args.destination) return fail("destination_required", "Say where the money goes (a PayPal email or Venmo handle).");
          const open = l.payouts.find((p) => p.status === "requested");
          if (open) return fail("payout_pending", "A payout is already requested.", { payout_id: open.payout_id });
          const amount = typeof args.amount === "number" ? args.amount : l.balance;
          if (amount > l.balance)
            return fail("insufficient_balance", "That is more than the balance.", { balance: { amount: l.balance, currency: "USD" } });
          if (amount < 10) return fail("below_minimum", "Payouts start at USD 10.", { min_payout: { amount: 10, currency: "USD" } });
          state.usage.writes += 1;
          const payout = {
            payout_id: `pay-${l.payouts.length}`,
            amount,
            currency: "USD",
            method: args.method,
            destination: args.destination,
            status: "requested",
            requested_at: new Date().toISOString(),
          };
          l.payouts.push(payout);
          l.balance -= amount;
          return ok(payout);
        },
      );
    }
    return server;
  }

  const transportFactory: TransportFactory = ({ key }) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    state.connections += 1;
    const server = buildServer(Boolean(key));
    void server.connect(serverTransport);
    return clientTransport;
  };

  /** A fetch that serves the signed PUTs: bytes land in `state.objects` by URL. */
  const storageFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (init?.method === "PUT") {
      const body = init.body;
      const bytes =
        body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(Buffer.from(String(body)));
      state.objects.set(url, bytes);
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { state, transportFactory, storageFetch };
}
