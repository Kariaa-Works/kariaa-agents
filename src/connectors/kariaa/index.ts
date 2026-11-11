/**
 * Kariaa DataHouse (tasks: every stage) and Kariaa job search (listings: find
 * only), both through Kariaa's public MCP server at agent.kariaa.com/mcp.
 */
import { defineConnector, type Connector, type ConnectorContext } from "../../core/connector.js";
import { ProtocolError, isProtocolError } from "../../core/errors.js";
import { queryWords } from "../../core/text.js";
import type { Account, MediaKind, NativeJob } from "../../core/types.js";
import { KARIAA_KEY_HELP, KARIAA_MCP_URL, KariaaClientPool, type KariaaClientOptions } from "./client.js";
import {
  earningsOf,
  isUuid,
  listingToJob,
  payoutOf,
  postingToJob,
  receiptOf,
  submissionToApplication,
  taskToJob,
  type Rec,
} from "./map.js";

export { KARIAA_KEY_HELP, KARIAA_MCP_URL, KariaaClientPool } from "./client.js";

export type KariaaConnectorOptions = KariaaClientOptions & { pool?: KariaaClientPool };

const KEY_ENV = "KARIAA_API_KEY";

const SYNONYMS: Record<string, string> = {
  voice: "audio",
  speech: "audio",
  speak: "audio",
  speaking: "audio",
  recording: "audio",
  recordings: "audio",
  read: "audio",
  reading: "audio",
  photo: "image",
  photos: "image",
  picture: "image",
  pictures: "image",
  camera: "image",
  clip: "video",
  clips: "video",
  film: "video",
  writing: "text",
  written: "text",
  label: "text",
  labeling: "text",
  labelling: "text",
  rate: "text",
  rating: "text",
};

function matchesTask(job: NativeJob, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = [job.title, job.summary, job.description, ...(job.tags ?? []), ...(job.requirements?.files?.kinds ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.some((word) => hay.includes(word) || (SYNONYMS[word] !== undefined && hay.includes(SYNONYMS[word]!)));
}

export function createKariaaConnectors(options: KariaaConnectorOptions = {}): {
  kariaa: Connector;
  kariaaJobs: Connector;
  pool: KariaaClientPool;
} {
  const pool = options.pool ?? new KariaaClientPool(options);
  const call = (tool: string, args: Record<string, unknown>, ctx: ConnectorContext) =>
    pool.call(tool, args, { key: ctx.credentials[KEY_ENV], signal: ctx.signal });

  const auth = { type: "api_key" as const, env: [KEY_ENV], help: KARIAA_KEY_HELP, required: false };

  const kariaa = defineConnector({
    id: "kariaa",
    name: "Kariaa DataHouse",
    description:
      "Paid data tasks: short video, photo, voice and text samples. Find a task, apply, add the samples, submit, and track the review. Unpaid verification samples first, then paid work at the task's rate.",
    homepage: "https://www.kariaa.com/datahouse",
    kinds: ["task"],
    category: "micro_task",
    tier: "managed",
    payoutRails: ["fiat"],
    auth,
    profileFields: [
      { name: "legal_first_name", description: "First name", example: "Ama" },
      { name: "legal_last_name", description: "Last name", example: "Mensah" },
      { name: "name", description: "Full name for job applications", example: "Ama Mensah" },
      { name: "phone_number", description: "Phone with country code", example: "+233201234567" },
      { name: "phone", description: "Phone number alias", example: "+233201234567" },
      { name: "location", description: "City and country", example: "Accra, Ghana" },
      { name: "occupation", description: "One to five occupations", example: '["Electrician"]' },
      { name: "language", description: "Preferred language", example: "English" },
      { name: "email", description: "Email address", example: "ama@example.com" },
      { name: "resume_url", description: "Public URL to CV/resume PDF", example: "https://example.com/cv.pdf" },
      { name: "linkedin_url", description: "LinkedIn profile URL", example: "https://linkedin.com/in/amamensah" },
      { name: "github_url", description: "GitHub profile URL", example: "https://github.com/amamensah" },
      { name: "portfolio_url", description: "Portfolio or personal website URL", example: "https://amamensah.dev" },
      { name: "bio", description: "Short candidate summary or cover note", example: "Senior software engineer with 6 years experience." },
    ],

    async search(query, ctx) {
      const listed = await call("list_tasks", { limit: 50 }, ctx);
      const tasks = Array.isArray(listed.tasks) ? (listed.tasks as Rec[]) : [];
      let jobs = tasks.map(taskToJob);
      if (query.media?.length) {
        const wanted = new Set<MediaKind>(query.media);
        jobs = jobs.filter((job) => job.requirements?.files?.kinds.some((k) => wanted.has(k as MediaKind)));
      }
      const words = queryWords(query.query);
      jobs = jobs.filter((job) => matchesTask(job, words));
      const limit = query.limit ?? 20;
      return { jobs: jobs.slice(0, limit), more: jobs.length > limit };
    },

    async get(nativeId, ctx) {
      if (!isUuid(nativeId)) throw new ProtocolError("not_found", `Kariaa task ids are UUIDs; ${JSON.stringify(nativeId)} is not one.`);
      try {
        return taskToJob(await call("get_task", { task_id: nativeId }, ctx));
      } catch (error) {
        if (!(isProtocolError(error) && error.code === "not_found")) throw error;
        let isApplication = false;
        try {
          await call("get_submission", { submission_id: nativeId }, ctx);
          isApplication = true;
        } catch {
          // not an application either, or not signed in
        }
        if (isApplication) {
          throw new ProtocolError("not_found", `kariaa:${nativeId} is an application id, not a task id. Call get_application with it.`);
        }
        throw error;
      }
    },

    async apply(nativeId, input, ctx) {
      const applied = await call(
        "apply_to_task",
        {
          task_id: nativeId,
          ...(input.answers ? { answers: input.answers } : {}),
          ...(input.preferred_rate ? { preferred_rate: input.preferred_rate } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
        ctx,
      );
      const submissionId = typeof applied.submission_id === "string" ? applied.submission_id : "";
      if (!submissionId) throw new ProtocolError("upstream_error", "Kariaa accepted the application but returned no submission id.");
      const application = submissionToApplication(await call("get_submission", { submission_id: submissionId }, ctx));
      if (Array.isArray(applied.ignored_answers) && applied.ignored_answers.length > 0) {
        application.raw = { ignored_answers: applied.ignored_answers };
      }
      return application;
    },

    async upload(nativeId, work, ctx) {
      if (work.kind === "text") {
        return receiptOf(await call("add_text_sample", { submission_id: nativeId, text: work.text }, ctx));
      }
      const slot = await call(
        "request_upload",
        { submission_id: nativeId, filename: work.name.slice(0, 120), mime_type: work.mime_type, size_bytes: work.bytes.byteLength },
        ctx,
      );
      const uploadUrl = typeof slot.upload_url === "string" ? slot.upload_url : "";
      const path = typeof slot.path === "string" ? slot.path : "";
      if (!uploadUrl || !path) throw new ProtocolError("upstream_error", "Kariaa returned no upload slot.");
      const headers =
        slot.headers && typeof slot.headers === "object" ? (slot.headers as Record<string, string>) : { "content-type": work.mime_type };
      let put: Response;
      try {
        put = await ctx.fetch(uploadUrl, {
          method: typeof slot.method === "string" ? slot.method : "PUT",
          headers,
          body: work.bytes,
          signal: ctx.signal,
        });
      } catch (error) {
        throw new ProtocolError(
          "upstream_error",
          `Uploading ${work.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (!put.ok)
        throw new ProtocolError("upstream_error", `Uploading ${work.name} failed with ${put.status}.`, { details: { status: put.status } });
      return receiptOf(await call("confirm_upload", { submission_id: nativeId, path }, ctx));
    },

    async remove(nativeId, fileId, ctx) {
      return receiptOf(await call("remove_sample", { submission_id: nativeId, file_id: fileId }, ctx));
    },

    async submit(nativeId, input, ctx) {
      try {
        await call("submit_samples", { submission_id: nativeId, ...(input.note ? { text_response: input.note } : {}) }, ctx);
      } catch (error) {
        const alreadySubmitted =
          isProtocolError(error) && error.code === "wrong_stage" && error.details?.kariaa_error === "already_submitted";
        if (!alreadySubmitted) throw error;
      }
      return submissionToApplication(await call("get_submission", { submission_id: nativeId }, ctx));
    },

    async status(nativeId, ctx) {
      if (!isUuid(nativeId)) return null;
      return submissionToApplication(await call("get_submission", { submission_id: nativeId }, ctx));
    },

    async list(ctx) {
      const listed = await call("my_submissions", { limit: 50 }, ctx);
      return (Array.isArray(listed.submissions) ? (listed.submissions as Rec[]) : []).map(submissionToApplication);
    },

    async link(nativeId, ctx) {
      const result = await call("get_upload_link", { submission_id: nativeId }, ctx);
      const url = typeof result.url === "string" ? result.url : "";
      if (!url) throw new ProtocolError("upstream_error", "Kariaa returned no link.");
      const minutes = typeof result.expires_in_minutes === "number" ? result.expires_in_minutes : undefined;
      return {
        url,
        ...(minutes ? { expires_at: new Date(Date.now() + minutes * 60_000).toISOString() } : {}),
        ...(typeof result.signed_in === "boolean" ? { signed_in: result.signed_in } : {}),
      };
    },

    async account(ctx) {
      return accountOf(await call("whoami", {}, ctx));
    },

    async updateAccount(fields, ctx) {
      const localOnlyKeys = new Set(["name", "phone", "resume_url", "linkedin_url", "github_url", "portfolio_url", "bio"]);
      const upstreamFields: Record<string, unknown> = {};
      const localFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (localOnlyKeys.has(k)) {
          localFields[k] = v;
        } else {
          upstreamFields[k] = v;
        }
      }
      if (typeof fields.name === "string" && fields.name.trim()) {
        const parts = fields.name.trim().split(/\s+/u);
        if (!upstreamFields.legal_first_name && parts[0]) upstreamFields.legal_first_name = parts[0];
        if (!upstreamFields.legal_last_name && parts.length > 1) upstreamFields.legal_last_name = parts.slice(1).join(" ");
      }
      if (typeof fields.phone === "string" && fields.phone.trim() && !upstreamFields.phone_number) {
        upstreamFields.phone_number = fields.phone.trim();
      }
      if (!ctx.credentials[KEY_ENV] && Object.keys(localFields).length > 0 && Object.keys(upstreamFields).length === 0) {
        return {
          signed_in: true,
          ready: true,
          profile: { ...fields },
        };
      }
      const result = Object.keys(upstreamFields).length > 0 ? await call("update_profile", upstreamFields, ctx) : {};
      const account = accountOf(await call("whoami", {}, ctx));
      if (Object.keys(localFields).length > 0) {
        account.profile = { ...(account.profile ?? {}), ...localFields };
      }
      if (Array.isArray(result.rejected) && result.rejected.length > 0) {
        account.rejected = (result.rejected as Rec[]).map((r) => ({ field: String(r.field ?? ""), reason: String(r.reason ?? "") }));
      }
      return account;
    },

    /** Kariaa's `my_earnings` tool (see README for the contract). */
    async earnings(ctx) {
      return earningsOf(await call("my_earnings", {}, ctx));
    },

    /** Kariaa's `request_payout` tool: `{ amount?, method, destination?, note? }`. */
    async payout(input, ctx) {
      const result = await call(
        "request_payout",
        {
          method: input.method,
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.destination ? { destination: input.destination } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
        ctx,
      );
      return payoutOf(result);
    },

    async close() {
      await pool.close();
    },
  });

  const kariaaJobs = defineConnector({
    id: "kariaa-jobs",
    name: "Kariaa job search",
    description:
      "Job listings Kariaa aggregates from Indeed, LinkedIn, Himalayas and other boards, anywhere in the world. Find only: apply on the employer's page.",
    homepage: "https://www.kariaa.com",
    kinds: ["listing"],
    category: "job",
    payoutRails: ["employer"],
    auth,

    async search(query, ctx) {
      const role = (query.query ?? "").trim();
      if (role.length < 2) return { jobs: [] };
      const result = await call(
        "search_jobs",
        {
          role: role.slice(0, 80),
          ...(query.location && query.location.trim().length >= 2 ? { location: query.location.trim().slice(0, 120) } : {}),
          ...(query.remote !== undefined ? { remote: query.remote } : {}),
          limit: Math.min(query.limit ?? 10, 20),
        },
        ctx,
      );
      const rows = Array.isArray(result.jobs) ? (result.jobs as Rec[]) : [];
      return { jobs: rows.map(listingToJob), more: result.more_pending === true };
    },

    async get(nativeId, ctx) {
      if (!isUuid(nativeId)) return null;
      return postingToJob(await call("get_job", { job_id: nativeId }, ctx));
    },
  });

  return { kariaa, kariaaJobs, pool };
}

function accountOf(me: Rec): Account {
  if (me.signed_in !== true) {
    return { signed_in: false, help: typeof me.how_to_sign_in === "string" ? me.how_to_sign_in : KARIAA_KEY_HELP };
  }
  const key = me.key && typeof me.key === "object" ? (me.key as Rec) : undefined;
  const quota = me.quota && typeof me.quota === "object" ? (me.quota as Rec) : undefined;
  const account: Account = {
    signed_in: true,
    ready: me.ready_to_apply === true,
    missing: Array.isArray(me.missing) ? me.missing.filter((m): m is string => typeof m === "string") : [],
  };
  if (typeof key?.label === "string") account.label = key.label;
  if (me.profile && typeof me.profile === "object") account.profile = me.profile as Record<string, unknown>;
  if (quota && typeof quota.calls_today === "number") {
    account.usage = {
      calls: Number(quota.calls_today),
      calls_max: Number(quota.calls_max ?? 0),
      writes: Number(quota.writes_today ?? 0),
      writes_max: Number(quota.writes_max ?? 0),
    };
  }
  if (!account.ready && account.missing?.length) {
    account.help = `Complete the profile first (update_profile): ${account.missing.join(", ")}.`;
  }
  return account;
}

const defaults = createKariaaConnectors({ url: process.env.KARIAA_MCP_URL?.trim() || KARIAA_MCP_URL });
export const kariaa = defaults.kariaa;
export const kariaaJobs = defaults.kariaaJobs;
