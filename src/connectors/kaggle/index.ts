/**
 * Kaggle competitions through the competitions RPC the official client uses
 * (api.kaggle.com/v1/competitions.CompetitionApiService). Find and read
 * competitions, enter, upload a submission file, submit it, follow the score.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConnector, type ConnectorContext } from "../../core/connector.js";
import { ProtocolError } from "../../core/errors.js";
import { fetchJson } from "../../core/http.js";
import { iso, num, str } from "../../core/jsonBoard.js";
import { truncate } from "../../core/text.js";
import type { NativeApplication, NativeJob } from "../../core/types.js";
import { perTenant, stateDir } from "../../core/tenant.js";

export const KAGGLE_RPC = "https://api.kaggle.com/v1/competitions.CompetitionApiService";
const ID = "kaggle";
const LABEL = "Kaggle";
const USER_ENV = "KAGGLE_USERNAME";
const KEY_ENV = "KAGGLE_KEY";
export const KAGGLE_HELP =
  "Set KAGGLE_USERNAME and KAGGLE_KEY from https://www.kaggle.com/settings (Create New Token). Every Kaggle call needs them.";

type Rec = Record<string, unknown>;
type Pending = { token: string; name: string; size: number; at: string };

const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);

/** One ApiCompetition as a job. The id is the competition's slug (`ref`). */
/** The list API answers `ref` as the competition's full URL, the detail API as its slug: ids are always the slug. */
export function competitionSlug(ref: string | undefined): string | undefined {
  return ref?.replace(/^https?:\/\/(?:www\.)?kaggle\.com\/(?:c|competitions)\//u, "").replace(/\/.*$/u, "") || undefined;
}

export function competitionToJob(c: Rec): NativeJob | null {
  const ref = competitionSlug(str(c.ref));
  const title = str(c.title);
  if (!ref || !title) return null;
  const reward = str(c.reward);
  const money = reward ? /^\$\s*([\d,]+(?:\.\d+)?)/u.exec(reward) : null;
  const amount = money ? Number(money[1]!.replace(/,/gu, "")) : undefined;
  // Kudos, Knowledge, Swag and Jobs competitions pay no money: say so with an amount of zero.
  const noCash = reward !== undefined && /^(kudos|knowledge|swag|jobs|points|none)$/iu.test(reward.trim());
  const pay = reward
    ? amount !== undefined
      ? { min: amount, max: amount, currency: "USD", period: "unit" as const, unit: "prize pool, split among the winners", text: reward }
      : noCash
        ? { min: 0, max: 0, currency: "USD", period: "unit" as const, text: `${reward} (no cash prize)` }
        : { period: "unit" as const, text: reward }
    : undefined;
  const tags = Array.isArray(c.tags) ? (c.tags as unknown[]).map((t) => str(rec(t)?.name)).filter((t): t is string => Boolean(t)) : [];
  const deadline = iso(c.deadline);
  const closed = c.submissionsDisabled === true || (deadline !== undefined && Date.parse(deadline) < Date.now());
  const url = str(c.url) ?? `https://www.kaggle.com/competitions/${ref}`;
  const description = str(c.description);
  const posted = iso(c.enabledDate);
  return {
    id: ref,
    kind: "task",
    title,
    ...(str(c.organizationName) ? { org: str(c.organizationName) } : {}),
    ...(description ? { summary: truncate(description, 300), description } : {}),
    ...(pay ? { pay } : {}),
    location: { remote: true },
    url,
    ...(posted ? { posted_at: posted } : {}),
    ...(deadline ? { expires_at: deadline } : {}),
    tags: [
      ...(str(c.category) ? [str(c.category)!.toLowerCase()] : []),
      ...tags.slice(0, 6),
      ...(c.isKernelsSubmissionsOnly === true ? ["notebook-submissions-only"] : []),
      ...(c.userHasEntered === true ? ["entered"] : []),
      "source:kaggle",
    ],
    ...(closed ? { stages: ["search", "get"] } : {}),
    apply_hint: `Accept the rules at ${url}/rules on kaggle.com first (there is no API for that), then apply_to_job, add_work with the submission file, and submit_work with a note.`,
  };
}

/** The newest submission to a competition as the application's state. */
export function submissionStage(
  s: Rec | undefined,
  pending: Pending | undefined,
): Pick<NativeApplication, "stage" | "next" | "updated_at"> {
  if (!s) {
    return pending
      ? { stage: "work_needed", next: `${pending.name} is uploaded. Call submit_work with a note to score it.` }
      : { stage: "work_needed", next: "Add the submission file with add_work, then submit_work." };
  }
  const status = String(s.status ?? "").toUpperCase();
  const updated = iso(s.date);
  const score = str(s.publicScore);
  if (status.endsWith("COMPLETE")) {
    return {
      stage: "accepted",
      next: score ? `Scored ${score} on the public leaderboard. Submit again any time.` : "Scored. Submit again any time.",
      ...(updated ? { updated_at: updated } : {}),
    };
  }
  if (status.endsWith("ERROR")) {
    return {
      stage: "rejected",
      next: `Kaggle could not score it: ${str(s.errorDescription) ?? "see the submissions page."} Fix the file and submit again.`,
      ...(updated ? { updated_at: updated } : {}),
    };
  }
  return { stage: "in_review", next: "Kaggle is scoring the submission.", ...(updated ? { updated_at: updated } : {}) };
}

function pendingFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = stateDir(env);
  return path.join(base, "kaggle-uploads.json");
}

/** Uploaded files waiting for submit_work, by competition; kept on disk so a second process can finish the submission. */
class PendingUploads {
  private memory: Record<string, Pending> | undefined;

  constructor(private readonly file: string = pendingFile()) {}

  private load(): Record<string, Pending> {
    if (this.memory) return this.memory;
    try {
      this.memory = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Pending>;
    } catch {
      this.memory = {};
    }
    return this.memory;
  }

  get(ref: string): Pending | undefined {
    return this.load()[ref];
  }

  set(ref: string, pending: Pending | undefined): void {
    const all = this.load();
    if (pending) all[ref] = pending;
    else delete all[ref];
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(all, null, 2));
    } catch {
      // memory still holds it for this process
    }
  }
}

export type KaggleOptions = { pendingFile?: string };

export function createKaggle(options: KaggleOptions = {}) {
  const pending = perTenant(() => new PendingUploads(options.pendingFile));

  const basicAuth = (ctx: ConnectorContext): string => {
    const user = ctx.credentials[USER_ENV];
    const key = ctx.credentials[KEY_ENV];
    if (!user || !key) throw new ProtocolError("auth_required", KAGGLE_HELP, { connector: ID });
    return `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`;
  };

  /** One RPC. Kaggle answers failures as JSON with a `code` as often as with an HTTP status. */
  const rpc = async <T extends Rec>(ctx: ConnectorContext, method: string, body: Rec): Promise<T> => {
    const answer = await fetchJson<T>(ctx, `${KAGGLE_RPC}/${method}`, {
      label: LABEL,
      connector: ID,
      method: "POST",
      headers: { authorization: basicAuth(ctx) },
      body,
      authHelp: KAGGLE_HELP,
    });
    const code = num(answer.code);
    if (code !== undefined && code >= 400) {
      const message = str(answer.message) ?? `Kaggle answered ${code}.`;
      const protocolCode =
        code === 401 || code === 403
          ? "auth_required"
          : code === 404
            ? "not_found"
            : code === 429
              ? "rate_limited"
              : code >= 500
                ? "upstream_error"
                : "invalid_input";
      throw new ProtocolError(protocolCode, protocolCode === "auth_required" ? `${message} ${KAGGLE_HELP}` : message, {
        connector: ID,
        details: { code },
      });
    }
    return answer;
  };

  const competition = async (ctx: ConnectorContext, ref: string): Promise<Rec> => {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(ref))
      throw new ProtocolError("not_found", `Kaggle competition ids are slugs; ${JSON.stringify(ref)} is not one.`, { connector: ID });
    return rpc<Rec>(ctx, "GetCompetition", { competitionName: ref });
  };

  const latestSubmission = async (ctx: ConnectorContext, ref: string): Promise<Rec | undefined> => {
    const answer = await rpc<{ submissions?: unknown[] }>(ctx, "ListSubmissions", { competitionName: ref, pageSize: 1 });
    return rec((answer.submissions ?? [])[0]);
  };

  const application = async (ctx: ConnectorContext, c: Rec, latest: Rec | undefined): Promise<NativeApplication> => {
    const ref = competitionSlug(str(c.ref)) ?? "";
    const entered = c.userHasEntered === true;
    const state = entered
      ? submissionStage(latest, pending().get(ref))
      : {
          stage: "applied" as const,
          next: `Accept the rules at ${str(c.url) ?? `https://www.kaggle.com/competitions/${ref}`}/rules on kaggle.com, then add_work and submit_work.`,
        };
    return {
      id: ref,
      job_id: ref,
      ...(str(c.title) ? { job_title: str(c.title) } : {}),
      ...state,
      url: `${str(c.url) ?? `https://www.kaggle.com/competitions/${ref}`}/submissions`,
      raw: { entered, latest: latest ?? null },
    };
  };

  return defineConnector({
    id: ID,
    name: LABEL,
    description:
      "Kaggle machine-learning competitions with cash prizes: find and read competitions, enter, upload a submission file, submit it and follow the score. Needs a Kaggle API token.",
    homepage: "https://www.kaggle.com/competitions",
    kinds: ["task"],
    category: "competition",
    tier: "self",
    payoutRails: ["fiat"],
    auth: { type: "api_key", env: [USER_ENV, KEY_ENV], help: KAGGLE_HELP, required: true },

    async search(query, ctx) {
      const limit = query.limit ?? 20;
      const answer = await rpc<{ competitions?: unknown[]; nextPageToken?: string }>(ctx, "ListCompetitions", {
        ...(query.query?.trim() ? { search: query.query.trim() } : {}),
        pageSize: Math.min(50, limit),
        page: 1,
      });
      const jobs = (answer.competitions ?? [])
        .map(rec)
        .map((c) => (c ? competitionToJob(c) : null))
        .filter((j): j is NativeJob => j !== null);
      return { jobs: jobs.slice(0, limit), more: Boolean(answer.nextPageToken) || jobs.length > limit };
    },

    async get(nativeId, ctx) {
      const slug = competitionSlug(nativeId);
      if (!slug || !/^[a-z0-9][a-z0-9-]*$/u.test(slug)) return null;
      return competitionToJob(await competition(ctx, slug));
    },

    async apply(nativeId, _input, ctx) {
      const c = await competition(ctx, nativeId);
      return application(ctx, c, c.userHasEntered === true ? await latestSubmission(ctx, nativeId) : undefined);
    },

    async upload(nativeApplicationId, work, ctx) {
      const ref = nativeApplicationId;
      const bytes = work.kind === "file" ? work.bytes : new TextEncoder().encode(work.text);
      const name = work.kind === "file" ? work.name : "submission.csv";
      const started = await rpc<{ token?: string; createUrl?: string }>(ctx, "StartSubmissionUpload", {
        competitionName: ref,
        contentLength: bytes.byteLength,
        lastModifiedEpochSeconds: Math.floor(Date.now() / 1000),
        fileName: name,
      });
      const token = str(started.token);
      const createUrl = str(started.createUrl);
      if (!token || !createUrl)
        throw new ProtocolError("upstream_error", "Kaggle answered the upload request without a token and an upload url.", {
          connector: ID,
        });
      await fetchJson(ctx, createUrl, {
        label: "Kaggle upload",
        connector: ID,
        method: "PUT",
        headers: { "content-length": String(bytes.byteLength), "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` },
        body: bytes,
        text: true,
      });
      const entry: Pending = { token, name, size: bytes.byteLength, at: new Date().toISOString() };
      pending().set(ref, entry);
      return { file: { id: token, name, kind: "file", size: bytes.byteLength }, next: "Call submit_work with a note; Kaggle scores it." };
    },

    async submit(nativeApplicationId, input, ctx) {
      const ref = nativeApplicationId;
      const entry = pending().get(ref);
      if (!entry)
        throw new ProtocolError("not_ready", "Nothing uploaded for this competition yet: add_work with the submission file first.", {
          connector: ID,
        });
      const answer = await rpc<{ message?: string; ref?: number }>(ctx, "CreateSubmission", {
        competitionName: ref,
        blobFileTokens: entry.token,
        submissionDescription: input.note?.trim() || entry.name,
      });
      pending().set(ref, undefined);
      const c = await competition(ctx, ref);
      const latest = await latestSubmission(ctx, ref);
      const app = await application(ctx, c, latest);
      return { ...app, ...(str(answer.message) && !latest ? { next: str(answer.message) } : {}) };
    },

    async status(nativeApplicationId, ctx) {
      const c = await competition(ctx, nativeApplicationId);
      return application(ctx, c, c.userHasEntered === true ? await latestSubmission(ctx, nativeApplicationId) : undefined);
    },

    async list(ctx) {
      const answer = await rpc<{ competitions?: unknown[] }>(ctx, "ListCompetitions", {
        group: "COMPETITION_LIST_TAB_ENTERED",
        pageSize: 50,
        page: 1,
      });
      const entered = (answer.competitions ?? []).map(rec).filter((c): c is Rec => Boolean(c));
      return Promise.all(entered.map((c) => application(ctx, c, undefined)));
    },

    async account(ctx) {
      const user = ctx.credentials[USER_ENV];
      if (!user || !ctx.credentials[KEY_ENV]) return { signed_in: false, help: KAGGLE_HELP };
      await rpc(ctx, "ListCompetitions", { group: "COMPETITION_LIST_TAB_ENTERED", pageSize: 1, page: 1 });
      return { signed_in: true, label: user, ready: true, profile: { username: user } };
    },
  });
}

export const kaggle = createKaggle();
