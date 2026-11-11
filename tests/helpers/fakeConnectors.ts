/** Connectors for tests: one with every stage, one find-only, one broken, one that never answers, one keyed. */
import { defineConnector, type Connector } from "../../src/core/connector.js";
import { ProtocolError } from "../../src/core/errors.js";
import type { ApplicationFile, NativeApplication, NativeJob, NativePayout, Progress } from "../../src/core/types.js";

export const FAKE_TASKS: NativeJob[] = [
  {
    id: "t1",
    kind: "task",
    title: "Read sentences aloud",
    org: "Fake Data",
    summary: "Record two short clips of yourself reading.",
    pay: { min: 0.5, max: 0.5, currency: "USD", period: "unit", unit: "per clip" },
    url: "https://fake.example/tasks/t1",
    tags: ["audio"],
    requirements: {
      questions: [{ id: "q1", question: "Which language?", type: "select", options: ["English", "French"], required: true }],
      files: { kinds: ["audio"], count: 2, max_seconds: 30 },
      how_to: ["Find a quiet room", "Read at a natural pace"],
      rules: ["Your own voice"],
    },
  },
  {
    id: "t2",
    kind: "task",
    title: "Label short texts",
    org: "Fake Data",
    summary: "Write the label for each text.",
    pay: { min: 2, max: 2, currency: "USD", period: "unit", unit: "per task" },
    url: "https://fake.example/tasks/t2",
    tags: ["text"],
    requirements: { files: { kinds: ["text"], count: 1 }, text: { min_chars: 20, max_chars: 20_000 } },
  },
];

export const FAKE_LISTINGS: NativeJob[] = [
  {
    id: "l1",
    kind: "listing",
    title: "Electrician",
    org: "Acme Power",
    location: { text: "Accra, Ghana" },
    url: "https://board.example/jobs/l1?utm_source=feed",
    posted_at: "2026-10-18T00:00:00.000Z",
  },
  {
    id: "l2",
    kind: "listing",
    title: "Registered Nurse",
    org: "City Hospital",
    location: { text: "Austin, TX" },
    url: "https://board.example/jobs/l2",
    posted_at: "2026-10-17T00:00:00.000Z",
  },
  {
    id: "l3",
    kind: "listing",
    title: "Electrician (remote support)",
    org: "Volt",
    location: { text: "Worldwide", remote: true },
    url: "https://board.example/jobs/l3",
  },
];

type Entry = { app: NativeApplication; files: ApplicationFile[]; wanted: number };

function words(query: string | undefined): string[] {
  return (query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
}

export type FullStageConnector = Connector & { entries: Map<string, Entry>; flags: { closed: boolean } };

export function fullStageConnector(id = "fake-tasks"): FullStageConnector {
  const entries = new Map<string, Entry>();
  const flags = { closed: false };
  const ledger: { balance: number; payouts: NativePayout[] } = { balance: 30, payouts: [] };
  let seq = 0;
  const progressOf = (entry: Entry): Progress => ({
    received: entry.files.length,
    wanted: entry.wanted,
    ready_to_submit: entry.files.length >= entry.wanted,
  });
  const refresh = (entry: Entry) => {
    entry.app.files = [...entry.files];
    entry.app.progress = progressOf(entry);
    entry.app.next =
      entry.app.stage === "work_needed" ? (entry.app.progress.ready_to_submit ? "Submit." : "Add work.") : "Wait for review.";
    return entry.app;
  };
  const entryOf = (appId: string): Entry => {
    const entry = entries.get(appId);
    if (!entry) throw new ProtocolError("not_found", `No application ${appId}.`);
    return entry;
  };
  const connector = defineConnector({
    id,
    name: "Fake tasks",
    description: "In-memory tasks with every stage.",
    kinds: ["task"],
    auth: { type: "none" },
    profileFields: [{ name: "location", description: "City and country" }],
    async search(query) {
      const w = words(query.query);
      let jobs = FAKE_TASKS.filter(
        (t) => w.length === 0 || w.some((word) => t.title.toLowerCase().includes(word) || t.tags?.includes(word)),
      );
      if (query.media?.length) jobs = jobs.filter((t) => t.requirements?.files?.kinds.some((k) => query.media!.includes(k as "text")));
      return { jobs, more: false };
    },
    async get(nativeId) {
      return FAKE_TASKS.find((t) => t.id === nativeId) ?? null;
    },
    async apply(nativeId, input) {
      const task = FAKE_TASKS.find((t) => t.id === nativeId);
      if (!task) throw new ProtocolError("not_found", `No task ${nativeId}.`);
      const required = (task.requirements?.questions ?? []).filter((q) => q.required);
      const missing = required.filter((q) => !input.answers?.[q.id]).map((q) => q.id);
      if (missing.length)
        throw new ProtocolError("invalid_input", `Answer ${missing.join(", ")} first.`, { details: { question_ids: missing } });
      const existing = [...entries.values()].find((e) => e.app.job_id === nativeId);
      if (existing) return existing.app;
      seq += 1;
      const entry: Entry = {
        app: { id: `a${seq}`, job_id: nativeId, job_title: task.title, stage: "work_needed", created_at: new Date().toISOString() },
        files: [],
        wanted: task.requirements?.files?.count ?? 1,
      };
      entries.set(entry.app.id, entry);
      return refresh(entry);
    },
    async upload(appId, work) {
      const entry = entryOf(appId);
      if (entry.app.stage !== "work_needed")
        throw new ProtocolError("wrong_stage", "Already submitted.", { details: { stage: entry.app.stage } });
      const file: ApplicationFile =
        work.kind === "text"
          ? { id: `f${entry.files.length + 1}`, name: "answer.txt", kind: "text", size: work.text.length }
          : {
              id: `f${entry.files.length + 1}`,
              name: work.name,
              kind: work.mime_type.split("/")[0] ?? "file",
              size: work.bytes.byteLength,
            };
      entry.files.push(file);
      refresh(entry);
      return { file, files: [...entry.files], progress: progressOf(entry), next: entry.app.next };
    },
    async remove(appId, fileId) {
      const entry = entryOf(appId);
      const index = entry.files.findIndex((f) => f.id === fileId);
      if (index < 0) throw new ProtocolError("not_found", `No file ${fileId}.`);
      const [removed] = entry.files.splice(index, 1);
      refresh(entry);
      return { removed: { id: removed!.id, name: removed!.name }, files: [...entry.files], progress: progressOf(entry) };
    },
    async submit(appId) {
      const entry = entryOf(appId);
      if (entry.app.stage === "in_review") return entry.app;
      if (!progressOf(entry).ready_to_submit)
        throw new ProtocolError("not_ready", "Add the rest of the work first.", { details: progressOf(entry) });
      entry.app.stage = "in_review";
      return refresh(entry);
    },
    async status(appId) {
      return entries.get(appId)?.app ?? null;
    },
    async list() {
      return [...entries.values()].map((e) => e.app);
    },
    async link(appId) {
      entryOf(appId);
      return { url: `https://fake.example/finish/${appId}`, expires_at: new Date(Date.now() + 900_000).toISOString() };
    },
    async account() {
      return { signed_in: true, label: "fake person", ready: true, missing: [] };
    },
    async updateAccount(fields) {
      return { signed_in: true, label: "fake person", ready: true, missing: [], profile: fields };
    },
    async earnings() {
      return {
        balance: { amount: ledger.balance, currency: "USD" },
        total_earned: { amount: 30, currency: "USD" },
        entries: [
          {
            id: "e1",
            application_id: "a0",
            job_title: "Earlier task",
            amount: 30,
            currency: "USD",
            status: "available",
            earned_at: "2026-10-01T00:00:00.000Z",
          },
        ],
        payouts: ledger.payouts,
        min_payout: { amount: 10, currency: "USD" },
        methods: ["paypal", "venmo"],
      };
    },
    async payout(input) {
      const amount = input.amount ?? ledger.balance;
      if (!["paypal", "venmo"].includes(input.method))
        throw new ProtocolError("invalid_input", "Method must be paypal or venmo.", { details: { methods: ["paypal", "venmo"] } });
      if (amount < 10)
        throw new ProtocolError("not_ready", "Payouts start at USD 10.", { details: { min_payout: { amount: 10, currency: "USD" } } });
      if (amount > ledger.balance)
        throw new ProtocolError("not_ready", "Not enough balance.", { details: { balance: { amount: ledger.balance, currency: "USD" } } });
      if (ledger.payouts.some((p) => p.status === "requested")) throw new ProtocolError("already_exists", "A payout is already requested.");
      const payout: NativePayout = {
        id: `p${ledger.payouts.length + 1}`,
        amount: { amount, currency: "USD" },
        method: input.method,
        status: "requested",
        requested_at: new Date().toISOString(),
      };
      if (input.destination) payout.destination = input.destination;
      ledger.payouts.push(payout);
      ledger.balance -= amount;
      return payout;
    },
    async close() {
      flags.closed = true;
    },
  });
  return Object.assign(connector, { entries, flags });
}

export function searchOnlyConnector(id = "fake-board", listings: NativeJob[] = FAKE_LISTINGS): Connector {
  return defineConnector({
    id,
    name: "Fake board",
    description: "In-memory listings, find only.",
    kinds: ["listing"],
    auth: { type: "none" },
    async search(query) {
      const w = words(query.query);
      let jobs = listings.filter((l) => w.length === 0 || w.some((word) => l.title.toLowerCase().includes(word)));
      if (query.remote === true) jobs = jobs.filter((l) => l.location?.remote === true);
      return { jobs, more: false };
    },
  });
}

export function throwingConnector(id = "fake-broken", error: Error = new Error("boom")): Connector {
  return defineConnector({
    id,
    name: "Broken board",
    description: "Always fails.",
    kinds: ["listing"],
    auth: { type: "none" },
    async search() {
      throw error;
    },
  });
}

export function hangingConnector(id = "fake-slow"): Connector {
  return defineConnector({
    id,
    name: "Slow board",
    description: "Never answers until aborted.",
    kinds: ["listing"],
    auth: { type: "none" },
    async search(_query, ctx) {
      await new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason ?? new Error("aborted")), { once: true });
      });
      return { jobs: [] };
    },
  });
}

export function keyedConnector(id = "fake-keyed"): Connector {
  return defineConnector({
    id,
    name: "Keyed board",
    description: "Needs FAKE_KEY.",
    kinds: ["listing"],
    auth: { type: "api_key", env: ["FAKE_KEY"], help: "Set FAKE_KEY." },
    async search(_query, ctx) {
      if (!ctx.credentials.FAKE_KEY) throw new ProtocolError("auth_required", "Set FAKE_KEY.");
      return { jobs: [{ id: "k1", kind: "listing", title: "Keyed job", url: "https://keyed.example/k1" }] };
    },
  });
}
