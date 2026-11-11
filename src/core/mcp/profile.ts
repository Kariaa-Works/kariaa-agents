/**
 * A profile links an MCP server to the protocol without code: which tool
 * serves each stage, how its arguments are built from the protocol's inputs,
 * and how its results map onto jobs, applications, earnings and accounts.
 */
import { z } from "zod";
import { defineConnector, type Connector, type ConnectorContext } from "../connector.js";
import { ERROR_CODES, ProtocolError, type ErrorCode } from "../errors.js";
import {
  mapMcpToolError,
  sharedMcpPool,
  toolResultJson,
  type McpClientPool,
  type McpErrorHints,
  type McpTransportSpec,
} from "../mcpClient.js";
import { FileOAuthProvider, oauthTokensExist } from "../oauth.js";
import { queryWords } from "../text.js";
import {
  APPLICATION_STAGES,
  AccountSchema,
  ConnectorCategorySchema,
  JobKindSchema,
  NativeApplicationSchema,
  NativeEarningsSchema,
  NativeJobSchema,
  PayoutRailSchema,
  type Account,
  type ApplicationStage,
  type NativeApplication,
  type NativeEarnings,
  type NativeJob,
  type SearchQuery,
} from "../types.js";
import { isPath, pick, setDeep, template } from "./pick.js";

const PathSchema = z.string().refine(isPath, "a path like $.jobs[*].title");

/** How one tool argument is built. A string starting with `$.` reads the input scope; other literals are passed as they are. */
const ArgSpecSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({
    from: z.string().optional(),
    const: z.unknown().optional(),
    default: z.unknown().optional(),
    required: z.boolean().optional(),
    transform: z.enum(["int", "number", "lower", "csv", "list", "bool", "string", "preview", "last"]).optional(),
  }),
]);
export type ArgSpec = z.infer<typeof ArgSpecSchema>;
const ArgMapSchema = z.record(z.string(), ArgSpecSchema);

/** How one output field is read. A bare path reads the item; an object adds fallbacks, templates, value maps and nested arrays. */
const FieldSpecSchema: z.ZodType<FieldSpec> = z.lazy(() =>
  z.union([
    PathSchema,
    z.object({
      path: PathSchema.optional(),
      /** Several paths: the first one with a value wins. */
      paths: z.array(PathSchema).optional(),
      /** Fallback from the input scope (`$.id`, `$.query`…). */
      input: z.string().optional(),
      template: z.string().optional(),
      const: z.unknown().optional(),
      default: z.unknown().optional(),
      /** Map upstream values to protocol values (statuses to stages). */
      values: z.record(z.string(), z.string()).optional(),
      /** Join an array into one string. */
      join: z.string().optional(),
      /** cents: divide by 100; number/int/string/lower/bool as named. */
      transform: z.enum(["cents", "number", "int", "string", "lower", "bool"]).optional(),
      /** A nested array: pick the items and map each. */
      items: PathSchema.optional(),
      fields: z.record(z.string(), FieldSpecSchema).optional(),
    }),
  ]),
);
export type FieldSpec =
  | string
  | {
      path?: string;
      paths?: string[];
      input?: string;
      template?: string;
      const?: unknown;
      default?: unknown;
      values?: Record<string, string>;
      join?: string;
      transform?: "cents" | "number" | "int" | "string" | "lower" | "bool";
      items?: string;
      fields?: Record<string, FieldSpec>;
    };
const FieldMapSchema = z.record(z.string(), FieldSpecSchema);

const ToolCallSchema = z.object({
  name: z.string().min(1),
  args: ArgMapSchema.default({}),
  /** Where the object to map sits in the result. Default the whole result. */
  root: PathSchema.optional(),
  /** For list-like results: where the array sits. */
  items: PathSchema.optional(),
  more: PathSchema.optional(),
  map: FieldMapSchema.default({}),
  /** Filters the server does not apply, applied here on the mapped jobs. */
  filter: z.array(z.enum(["query", "location", "remote"])).optional(),
  /** After the call, fetch the application with `status` and return that. */
  then: z.enum(["status"]).optional(),
  /** Input paths that must be present; otherwise search answers nothing instead of calling. */
  skipWithout: z.array(z.string()).optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

const SyntheticApplySchema = z.object({
  synthetic: z.literal(true),
  /** What the agent should do next (for example "submit_work with your result in note"). */
  next: z.string().optional(),
});

export const McpProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  name: z.string().min(1),
  description: z.string().min(1),
  homepage: z.string().url().optional(),
  kinds: z.array(JobKindSchema).min(1),
  /** How the source pays (see Connector.category). */
  category: ConnectorCategorySchema.optional(),
  /** Where the money lands. */
  payoutRails: z.array(PayoutRailSchema).optional(),
  transport: z.discriminatedUnion("type", [
    z.object({ type: z.literal("http"), url: z.string().url() }),
    z.object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      /** Variables copied from the host environment into the process when set. */
      envFrom: z.array(z.string()).optional(),
    }),
  ]),
  auth: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("none") }),
      z.object({ type: z.literal("bearer"), env: z.string().min(1), help: z.string().min(1), required: z.boolean().optional() }),
      z.object({
        type: z.literal("header"),
        name: z.string().min(1),
        env: z.string().min(1),
        help: z.string().min(1),
        required: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("oauth"),
        help: z.string().optional(),
        scope: z.string().optional(),
        env: z.string().optional(),
        required: z.boolean().optional(),
      }),
      /** A credential handed to a stdio server through its environment. */
      z.object({ type: z.literal("env"), env: z.string().min(1), help: z.string().min(1), required: z.boolean().optional() }),
    ])
    .default({ type: "none" }),
  tools: z.object({
    search: ToolCallSchema,
    get: ToolCallSchema.optional(),
    apply: z.union([ToolCallSchema, SyntheticApplySchema]).optional(),
    submit: ToolCallSchema.optional(),
    status: ToolCallSchema.optional(),
    list: ToolCallSchema.optional(),
    earnings: ToolCallSchema.optional(),
    account: ToolCallSchema.optional(),
    link: ToolCallSchema.optional(),
  }),
  profileFields: z.array(z.object({ name: z.string(), description: z.string(), example: z.string().optional() })).optional(),
  /** Upstream error codes → protocol codes. */
  errors: z.record(z.string(), z.enum(ERROR_CODES)).optional(),
  /** A query the live conformance run uses. */
  sample: z.object({ query: z.string().optional(), location: z.string().optional() }).optional(),
  /** true: searched only when named (local processes, chain reads, paid calls). */
  optIn: z.boolean().optional(),
  notes: z.string().optional(),
});
export type McpProfile = z.infer<typeof McpProfileSchema>;
/** What a profile file writes: the same shape with the defaults (`auth`) optional. */
export type McpProfileInput = z.input<typeof McpProfileSchema>;

export type McpConnectorOptions = {
  pool?: McpClientPool;
  /** The OAuth provider for `auth.type: "oauth"`; default: the file-backed one, when it holds tokens. */
  oauthProvider?: (profile: McpProfile) => FileOAuthProvider | undefined;
  env?: NodeJS.ProcessEnv;
};

type Scope = Record<string, unknown>;

function transform(value: unknown, how: string | undefined): unknown {
  if (value === undefined || value === null) return value;
  switch (how) {
    case "int":
      return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : undefined;
    case "number":
      return Number.isFinite(Number(value)) ? Number(value) : undefined;
    case "cents":
      return Number.isFinite(Number(value)) ? Number(value) / 100 : undefined;
    case "last":
      return String(value)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .at(-1);
    case "preview": {
      const text = String(value).trim();
      if (text.length <= 500) return text;
      const cut = text.slice(0, 500);
      return `${cut.slice(0, Math.max(300, cut.lastIndexOf(" ")))}…`;
    }
    case "lower":
      return String(value).toLowerCase();
    case "csv":
      return Array.isArray(value) ? value.join(",") : String(value);
    case "list":
      return (Array.isArray(value) ? value : String(value).split(",")).map((v) => String(v).trim()).filter(Boolean);
    case "bool":
      return value === true || value === "true" || value === 1;
    case "string":
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    default:
      return value;
  }
}

/** Builds a tool's arguments from the input scope; missing required values answer invalid_input. */
export function buildArgs(spec: Record<string, ArgSpec>, scope: Scope, label: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, arg] of Object.entries(spec)) {
    let value: unknown;
    let required = false;
    let fallback: unknown;
    let how: string | undefined;
    if (typeof arg === "string" && arg.startsWith("$.")) value = pick(scope, arg);
    else if (arg && typeof arg === "object") {
      required = arg.required === true;
      fallback = arg.default;
      how = arg.transform;
      if (arg.const !== undefined) value = arg.const;
      else if (arg.from) value = pick(scope, arg.from);
    } else value = arg;
    value = transform(value, how);
    if (value === undefined || value === null || value === "") value = fallback;
    if (value === undefined || value === null || value === "") {
      if (required) {
        const source = typeof arg === "object" && arg && "from" in arg ? arg.from : typeof arg === "string" ? arg : name;
        throw new ProtocolError("invalid_input", `${label} needs ${name}: give it as ${String(source).replace(/^\$\./u, "")}.`, {
          details: { field: name },
        });
      }
      continue;
    }
    out[name] = value;
  }
  return out;
}

function readField(spec: FieldSpec, item: unknown, scope: Scope): unknown {
  if (typeof spec === "string") return pick(item, spec);
  let value: unknown;
  if (spec.const !== undefined) value = spec.const;
  else if (spec.items) {
    const list = pick(item, spec.items);
    if (!Array.isArray(list)) return spec.default;
    return list.map((entry) => buildObject(spec.fields ?? {}, entry, scope));
  } else if (spec.paths) value = spec.paths.map((p) => pick(item, p)).find((v) => v !== undefined && v !== null && v !== "");
  else if (spec.path) value = pick(item, spec.path);
  if ((value === undefined || value === null || value === "") && spec.template !== undefined) value = template(spec.template, item);
  if ((value === undefined || value === null || value === "") && spec.input) value = pick(scope, spec.input);
  if (value === undefined || value === null || value === "") value = spec.default;
  if (value === undefined) return undefined;
  if (spec.values && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
    value = spec.values[String(value)] ?? spec.values["*"] ?? value;
  if (spec.join !== undefined && Array.isArray(value)) value = value.join(spec.join);
  if (spec.transform) value = transform(value, spec.transform);
  return value;
}

/** Maps one result item onto an object with dotted keys. */
export function buildObject(fields: Record<string, FieldSpec>, item: unknown, scope: Scope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const value = readField(spec, item, scope);
    if (value !== undefined && value !== null && value !== "") setDeep(out, key, value);
  }
  return out;
}

const TRUE_WORDS = /^(true|yes|remote|fully remote|anywhere|worldwide|1)$/iu;
const PERIOD_WORD: Record<string, string> = {
  yearly: "year",
  annual: "year",
  monthly: "month",
  weekly: "week",
  daily: "day",
  hourly: "hour",
};

function tidyJob(raw: Record<string, unknown>, kind: NativeJob["kind"]): Record<string, unknown> {
  const job: Record<string, unknown> = { kind, ...raw };
  if (job.id !== undefined) job.id = String(job.id);
  if (typeof job.tags === "string")
    job.tags = (job.tags as string)
      .split(/[,;]/u)
      .map((t) => t.trim())
      .filter(Boolean);
  if (Array.isArray(job.tags))
    job.tags = (job.tags as unknown[]).filter((t) => typeof t === "string" && t.trim()).map((t) => String(t).trim());
  const location = job.location as Record<string, unknown> | undefined;
  if (location && typeof location === "object") {
    if (typeof location.remote === "string") location.remote = TRUE_WORDS.test(location.remote);
    if (location.text !== undefined && typeof location.text !== "string") location.text = String(location.text);
    if (!Object.keys(location).length) delete job.location;
  }
  const pay = job.pay as Record<string, unknown> | undefined;
  if (pay && typeof pay === "object") {
    for (const key of ["min", "max"]) {
      if (pay[key] !== undefined && typeof pay[key] !== "number") {
        const n = Number(String(pay[key]).replace(/[^0-9.]/gu, ""));
        if (Number.isFinite(n) && n > 0) pay[key] = n;
        else delete pay[key];
      }
    }
    if (pay.text && typeof pay.text === "object") {
      // A structured salary ({min, max, currency, period}) mapped onto text: take its numbers and write the text.
      const salary = pay.text as Record<string, unknown>;
      delete pay.text;
      for (const key of ["min", "max"]) {
        const n = Number(salary[key]);
        if (pay[key] === undefined && Number.isFinite(n) && n > 0) pay[key] = n;
      }
      if (pay.currency === undefined && typeof salary.currency === "string") pay.currency = salary.currency;
      const range = [pay.min, pay.max].filter((n) => typeof n === "number").map((n) => (n as number).toLocaleString("en-US"));
      const period = [salary.period, salary.interval, salary.unit].find((v) => typeof v === "string" && v.trim());
      if (range.length)
        pay.text = `${typeof pay.currency === "string" ? `${pay.currency} ` : ""}${[...new Set(range)].join("–")}${period ? ` per ${PERIOD_WORD[String(period).toLowerCase()] ?? String(period).toLowerCase()}` : ""}`;
    }
    if (pay.text !== undefined && typeof pay.text !== "string") pay.text = String(pay.text);
    if (!Object.keys(pay).length) delete job.pay;
  }
  for (const key of ["summary", "description", "instructions", "url", "org", "title", "posted_at", "expires_at"]) {
    if (job[key] !== undefined && typeof job[key] !== "string") job[key] = String(job[key]);
  }
  return job;
}

function tidyApplication(raw: Record<string, unknown>, inputId: string): Record<string, unknown> {
  const app: Record<string, unknown> = { ...raw };
  app.id = app.id === undefined ? inputId : String(app.id);
  app.job_id = app.job_id === undefined ? inputId : String(app.job_id);
  if (typeof app.stage !== "string" || !(APPLICATION_STAGES as readonly string[]).includes(app.stage)) app.stage = "applied";
  return app;
}

function hintsFor(profile: McpProfile): McpErrorHints {
  const help =
    profile.auth.type === "bearer" || profile.auth.type === "header" || profile.auth.type === "env"
      ? profile.auth.help
      : profile.auth.type === "oauth"
        ? (profile.auth.help ?? `Sign in with \`work login ${profile.id}\`.`)
        : undefined;
  return { label: profile.name, ...(help ? { help } : {}), ...(profile.errors ? { errors: profile.errors } : {}) };
}

/** Turns a validated profile into a connector. Only the stages the profile declares get methods. */
export function defineMcpConnector(input: unknown, options: McpConnectorOptions = {}): Connector {
  const parsed = McpProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProtocolError(
      "invalid_input",
      `Invalid MCP profile: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const profile = parsed.data;
  const pool = options.pool ?? sharedMcpPool();
  const hints = hintsFor(profile);
  for (const stage of ["apply", "submit", "status", "list"] as const) {
    const tool = profile.tools[stage];
    if (!tool || !("map" in tool)) continue;
    const unknown = Object.keys(tool.map).filter((key) => !(key.split(".")[0]! in NativeApplicationSchema.shape));
    if (unknown.length) {
      throw new ProtocolError(
        "invalid_input",
        `Profile ${profile.id}: tools.${stage}.map uses fields an application has no room for (${unknown.join(", ")}). Put them under raw or next.`,
      );
    }
  }
  const authEnv = profile.auth.type === "none" ? undefined : profile.auth.env;
  const authRequired = profile.auth.type !== "none" && profile.auth.required !== false;

  let fileProvider: FileOAuthProvider | undefined;
  const spec = (ctx: ConnectorContext): McpTransportSpec => {
    if (profile.transport.type === "stdio") {
      const env: Record<string, string> = { ...(profile.transport.env ?? {}) };
      for (const name of profile.transport.envFrom ?? []) {
        const value = (options.env ?? process.env)[name];
        if (value) env[name] = value;
      }
      if (profile.auth.type === "env" && authEnv && ctx.credentials[authEnv]) env[authEnv] = ctx.credentials[authEnv]!;
      return { type: "stdio", command: profile.transport.command, args: profile.transport.args, env };
    }
    const headers: Record<string, string> = {};
    const credential = authEnv ? ctx.credentials[authEnv] : undefined;
    const oauthToken = credential || ctx.credentials.WORK_OAUTH_ACCESS_TOKEN;
    const hosted = ctx.credentials.WORK_HOSTED === "1" || (options.env ?? process.env).WORK_HOSTED === "1";
    let authProvider: FileOAuthProvider | undefined;
    if (profile.auth.type === "bearer" && credential) headers.authorization = `Bearer ${credential}`;
    else if (profile.auth.type === "header" && credential) headers[profile.auth.name] = credential;
    else if (profile.auth.type === "oauth") {
      if (oauthToken) headers.authorization = `Bearer ${oauthToken}`;
      else if (!hosted && options.oauthProvider) authProvider = options.oauthProvider(profile);
      // One provider per connector: the pool keys connections on it, and it reads the token file on every call.
      else if (!hosted && oauthTokensExist(profile.id, options.env))
        authProvider = fileProvider ??= new FileOAuthProvider(profile.id, { env: options.env });
    }
    return { type: "http", url: profile.transport.url, headers, fetch: ctx.fetch, ...(authProvider ? { authProvider } : {}) };
  };

  const signedIn = (ctx: ConnectorContext): boolean => {
    if (profile.auth.type === "none") return true;
    const credential = authEnv ? ctx.credentials[authEnv] : undefined;
    if (credential || ctx.credentials.WORK_OAUTH_ACCESS_TOKEN) return true;
    if (ctx.credentials.WORK_HOSTED === "1" || (options.env ?? process.env).WORK_HOSTED === "1") return false;
    if (profile.auth.type === "oauth")
      return options.oauthProvider ? Boolean(options.oauthProvider(profile)) : oauthTokensExist(profile.id, options.env);
    return false;
  };

  const requireAuth = (ctx: ConnectorContext, writing: boolean): void => {
    if (signedIn(ctx)) return;
    if (!writing && !authRequired) return;
    throw new ProtocolError("auth_required", hints.help ?? `${profile.name} needs a credential.`, { details: { connector: profile.id } });
  };

  const call = async (ctx: ConnectorContext, tool: ToolCall, scope: Scope): Promise<Record<string, unknown>> => {
    const args = buildArgs(tool.args, scope, profile.name);
    const result = await pool.call(spec(ctx), tool.name, args, hints, { signal: ctx.signal });
    if (result.isError) throw mapMcpToolError(tool.name, result, hints);
    return toolResultJson(result, profile.name, tool.name);
  };

  const scopeFor = (ctx: ConnectorContext, extra: Scope): Scope => ({ ...extra, credentials: ctx.credentials });

  const jobsFrom = (tool: ToolCall, result: Record<string, unknown>, scope: Scope, ctx: ConnectorContext): NativeJob[] => {
    const items = tool.items ? pick(result, tool.items) : (result.items ?? result.jobs ?? result.results ?? result.data);
    if (!Array.isArray(items)) return [];
    const jobs: NativeJob[] = [];
    for (const item of items) {
      const mapped = tidyJob(buildObject(tool.map, item, scope), profile.kinds[0]!);
      const parsedJob = NativeJobSchema.safeParse(mapped);
      if (parsedJob.success) jobs.push(parsedJob.data);
      else
        ctx.log("mcp.row_invalid", {
          connector: profile.id,
          issues: parsedJob.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 3),
        });
    }
    return jobs;
  };

  const applicationFrom = (tool: ToolCall, result: Record<string, unknown>, scope: Scope, inputId: string): NativeApplication => {
    const root = tool.root ? pick(result, tool.root) : result;
    const mapped = tidyApplication(buildObject(tool.map, root, scope), inputId);
    const parsedApp = NativeApplicationSchema.safeParse(mapped);
    if (!parsedApp.success) {
      throw new ProtocolError(
        "upstream_error",
        `${profile.name} answered in a shape the profile cannot map: ${parsedApp.error.issues.map((i) => i.path.join(".")).join(", ")}.`,
        {
          details: { result },
        },
      );
    }
    return parsedApp.data;
  };

  const connector: Connector = {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    ...(profile.homepage ? { homepage: profile.homepage } : {}),
    kinds: profile.kinds,
    ...(profile.category ? { category: profile.category } : {}),
    ...(profile.payoutRails ? { payoutRails: profile.payoutRails } : {}),
    ...(profile.optIn ? { optIn: true } : {}),
    auth:
      profile.auth.type === "none"
        ? { type: "none" }
        : profile.auth.type === "oauth"
          ? {
              type: "oauth",
              help: hints.help ?? `Sign in with \`work login ${profile.id}\`.`,
              ...(profile.auth.env ? { env: profile.auth.env } : {}),
              required: profile.auth.required === true,
            }
          : { type: "api_key", env: [profile.auth.env], help: profile.auth.help, required: profile.auth.required !== false },
    ...(profile.profileFields ? { profileFields: profile.profileFields } : {}),

    async search(query: SearchQuery, ctx) {
      requireAuth(ctx, false);
      const tool = profile.tools.search;
      const scope = scopeFor(ctx, { ...query, query: query.query ?? "", limit: query.limit ?? 20 });
      for (const needed of tool.skipWithout ?? []) {
        const value = pick(scope, needed);
        if (value === undefined || value === null || value === "") return { jobs: [] };
      }
      const result = await call(ctx, tool, scope);
      let jobs = jobsFrom(tool, result, scope, ctx);
      const filters = tool.filter ?? [];
      const words = queryWords(query.query);
      if (filters.includes("query") && words.length) {
        jobs = jobs.filter((job) => {
          const hay = [job.title, job.org, job.summary, job.description, ...(job.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
          return words.every((w) => hay.includes(w));
        });
      }
      const place = query.location?.trim().toLowerCase();
      if (filters.includes("location") && place) {
        jobs = jobs.filter((job) => {
          const text = `${job.location?.text ?? ""} ${job.location?.country ?? ""}`.toLowerCase();
          return !text.trim() || text.includes(place) || /worldwide|anywhere|global|remote/u.test(text);
        });
      }
      if (filters.includes("remote") && query.remote === true) jobs = jobs.filter((job) => job.location?.remote === true);
      const limit = query.limit ?? 20;
      const more = (tool.more ? Boolean(pick(result, tool.more)) : false) || jobs.length > limit;
      return { jobs: jobs.slice(0, limit), more };
    },

    /** Drops this server's connections (the shared pool reconnects on the next call), so a CLI process can exit. */
    async close() {
      await pool.close();
    },
  };

  const getTool = profile.tools.get;
  if (getTool) {
    connector.get = async (nativeId, ctx) => {
      requireAuth(ctx, false);
      const scope = scopeFor(ctx, { id: nativeId });
      const result = await call(ctx, getTool, scope);
      const root = getTool.root ? pick(result, getTool.root) : result;
      if (root === undefined || root === null) return null;
      const mapped = tidyJob(buildObject(getTool.map, root, scope), profile.kinds[0]!);
      if (mapped.id === undefined) mapped.id = nativeId;
      const parsedJob = NativeJobSchema.safeParse(mapped);
      if (!parsedJob.success) return null;
      return parsedJob.data;
    };
  }

  const applyTool = profile.tools.apply;
  if (applyTool) {
    connector.apply = async (nativeId, input, ctx) => {
      if ("synthetic" in applyTool) {
        return {
          id: nativeId,
          job_id: nativeId,
          stage: "work_needed",
          next: applyTool.next ?? "Send the work with submit_work (put the deliverable in note).",
        };
      }
      requireAuth(ctx, true);
      const scope = scopeFor(ctx, {
        id: nativeId,
        answers: input.answers ?? {},
        note: input.note ?? "",
        preferred_rate: input.preferred_rate ?? "",
        input,
      });
      const result = await call(ctx, applyTool, scope);
      return applicationFrom(applyTool, result, scope, nativeId);
    };
  }

  const statusTool = profile.tools.status;
  if (statusTool) {
    connector.status = async (nativeId, ctx) => {
      requireAuth(ctx, true);
      const scope = scopeFor(ctx, { id: nativeId });
      const result = await call(ctx, statusTool, scope);
      if (statusTool.items) {
        const items = pick(result, statusTool.items);
        if (!Array.isArray(items)) return null;
        const match = items.find((item) => {
          const mapped = buildObject(statusTool.map, item, scope);
          return String(mapped.id ?? mapped.job_id ?? "") === nativeId;
        });
        return match ? applicationFrom({ ...statusTool, root: undefined }, match as Record<string, unknown>, scope, nativeId) : null;
      }
      const root = statusTool.root ? pick(result, statusTool.root) : result;
      if (root === undefined || root === null) return null;
      return applicationFrom({ ...statusTool, root: undefined }, root as Record<string, unknown>, scope, nativeId);
    };
  }

  const submitTool = profile.tools.submit;
  if (submitTool) {
    connector.submit = async (nativeId, input, ctx) => {
      requireAuth(ctx, true);
      const scope = scopeFor(ctx, { id: nativeId, note: input.note ?? "", input });
      const result = await call(ctx, submitTool, scope);
      if (submitTool.then === "status" && connector.status) {
        const current = await connector.status(nativeId, ctx);
        if (current) return current;
      }
      return applicationFrom(submitTool, result, scope, nativeId);
    };
  }

  const listTool = profile.tools.list;
  if (listTool) {
    connector.list = async (ctx) => {
      requireAuth(ctx, true);
      const scope = scopeFor(ctx, {});
      const result = await call(ctx, listTool, scope);
      const items = listTool.items ? pick(result, listTool.items) : (result.items ?? result.applications ?? result.jobs ?? result.data);
      if (!Array.isArray(items)) return [];
      const apps: NativeApplication[] = [];
      for (const item of items) {
        const mapped = tidyApplication(buildObject(listTool.map, item, scope), "");
        if (!mapped.id) continue;
        const parsedApp = NativeApplicationSchema.safeParse(mapped);
        if (parsedApp.success) apps.push(parsedApp.data);
        else
          ctx.log("mcp.application_invalid", {
            connector: profile.id,
            issues: parsedApp.error.issues.map((i) => i.path.join(".")).slice(0, 3),
          });
      }
      return apps;
    };
  }

  const earningsTool = profile.tools.earnings;
  if (earningsTool) {
    connector.earnings = async (ctx) => {
      requireAuth(ctx, true);
      const scope = scopeFor(ctx, {});
      const result = await call(ctx, earningsTool, scope);
      const root = earningsTool.root ? pick(result, earningsTool.root) : result;
      const mapped = buildObject(earningsTool.map, root, scope) as Record<string, unknown>;
      const balance = mapped.balance as Record<string, unknown> | undefined;
      if (balance && typeof balance.amount !== "number") balance.amount = Number(balance.amount) || 0;
      if (balance && typeof balance.currency !== "string") balance.currency = "USD";
      const parsedEarnings = NativeEarningsSchema.safeParse(mapped);
      if (!parsedEarnings.success) {
        throw new ProtocolError(
          "upstream_error",
          `${profile.name} answered earnings in a shape the profile cannot map: ${parsedEarnings.error.issues.map((i) => i.path.join(".")).join(", ")}.`,
          {
            details: { result },
          },
        );
      }
      return parsedEarnings.data as NativeEarnings;
    };
  }

  const accountTool = profile.tools.account;
  if (accountTool) {
    connector.account = async (ctx) => {
      if (!signedIn(ctx)) return { signed_in: false, help: hints.help ?? `${profile.name} needs a credential.` };
      const scope = scopeFor(ctx, {});
      const result = await call(ctx, accountTool, scope);
      const root = accountTool.root ? pick(result, accountTool.root) : result;
      const mapped = { signed_in: true, ...buildObject(accountTool.map, root, scope) };
      const parsedAccount = AccountSchema.safeParse(mapped);
      return parsedAccount.success ? (parsedAccount.data as Account) : { signed_in: true, profile: mapped };
    };
  }

  const linkTool = profile.tools.link;
  if (linkTool) {
    connector.link = async (nativeId, ctx) => {
      requireAuth(ctx, true);
      const scope = scopeFor(ctx, { id: nativeId });
      const result = await call(ctx, linkTool, scope);
      const mapped = buildObject(linkTool.map, linkTool.root ? pick(result, linkTool.root) : result, scope);
      const url = typeof mapped.url === "string" ? mapped.url : "";
      if (!url) throw new ProtocolError("upstream_error", `${profile.name} returned no link.`);
      return { url, ...(typeof mapped.expires_at === "string" ? { expires_at: mapped.expires_at } : {}) };
    };
  }

  const linked = connector as McpLinkedConnector;
  linked.profile = profile;
  linked.callTool = async (tool, args, ctx) => {
    const result = await pool.call(spec(ctx), tool, args, hints, { signal: ctx.signal });
    if (result.isError) throw mapMcpToolError(tool, result, hints);
    try {
      return toolResultJson(result, profile.name, tool);
    } catch {
      return { text: (result.content ?? []).map((c) => c.text ?? "").join("\n") };
    }
  };
  linked.listTools = async (ctx) =>
    (await pool.listTools(spec(ctx), hints)).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputs: Object.keys((t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}),
    }));
  return defineConnector(linked);
}

/** A connector made from a profile also exposes its tools directly, for `work mcp call` and `work mcp inspect`. */
export type McpLinkedConnector = Connector & {
  profile: McpProfile;
  callTool(tool: string, args: Record<string, unknown>, ctx: ConnectorContext): Promise<Record<string, unknown>>;
  listTools(ctx: ConnectorContext): Promise<Array<{ name: string; description: string; inputs: string[] }>>;
};

export function isMcpLinked(connector: Connector): connector is McpLinkedConnector {
  return typeof (connector as McpLinkedConnector).callTool === "function" && typeof (connector as McpLinkedConnector).profile === "object";
}

export const STAGE_KEYS: Array<keyof McpProfile["tools"]> = [
  "search",
  "get",
  "apply",
  "submit",
  "status",
  "list",
  "earnings",
  "account",
  "link",
];
export type { ApplicationStage };
