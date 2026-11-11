#!/usr/bin/env node
/**
 * `work`: the protocol from a terminal, for people and shell-driven harnesses.
 * Every command takes --json for machine output. A ProtocolError prints
 * `code: message` and exits 1.
 */
import { ConnectorHealth } from "../core/health.js";
import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { fileURLToPath } from "node:url";
import { isMcpLinked } from "../core/mcp/profile.js";
import { fileCredentialStore } from "../core/connect.js";
import { credentialsFor } from "../core/credentials.js";
import { isEntryPoint, loadDotEnv } from "../core/env.js";
import { persistedConfirmSecret } from "../core/payConfirm.js";
import { JobCache, defaultCacheFile } from "../core/jobCache.js";
import { ProtocolError, toProtocolError } from "../core/errors.js";
import type { WorkProtocol } from "../core/router.js";
import { CONNECTOR_CATEGORIES, type Application, type ConnectorCategory, type Job, type SearchQuery } from "../core/types.js";
import { VERSION } from "../core/version.js";
import { createProtocol } from "../index.js";
import { defaultIndexFile, fetchUsdRates, indexCatalog, LocalIndex, localIndexIfBuilt, openAiEmbedder } from "../search/index.js";
import {
  renderAccount,
  renderApplication,
  renderConnection,
  renderConnectors,
  renderEarnings,
  renderJob,
  renderJobLine,
  renderOffer,
  renderPayment,
  renderPosting,
  renderPayout,
  renderReceipt,
  renderVerification,
} from "../mcp/server.js";

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  /** A ready protocol (tests); otherwise one is created from the environment. */
  protocol?: WorkProtocol;
};

const USAGE = `work ${VERSION}: find work, apply, do it, submit it.

  work connectors                                  sources, stages and key status
  work search [query] [--in <place>] [--remote] [--kind task|listing] [--category bounty|micro_task|selling|competition|job] [--media audio,video] [--direct-apply] [--pay-min n] [--connector <id>]... [--limit n]
  work get <id>                                    full job or task
  work apply <job-id> [--answer q=v]... [--note ..] [--rate ..]
  work verify <job-id> [<file>]... [--text ".."]... [--answer q=v]...   check work before sending it (exit 0 pass, 2 fail, 3 uncertain)
  work add <app-id> <file> | --text ".." | --url https://..   [--name f.mp4] [--mime video/mp4]
  work remove <app-id> <file-id>
  work submit <app-id> [--note ..]
  work status <app-id>
  work mine [--connector <id>]
  work link <app-id>                               web link to finish in a browser
  work me                                          accounts and profile readiness
  work profile --connector <id> field=value...     update a profile
  work earnings [--connector <id>]                 balance, accepted work, payouts so far
  work payout --connector <id> --method paypal [--to <email>] [--amount 25] [--note ..]
  work post --connector <id> --title ".." --description ".." --budget 30 --currency USD [--accept ".."]... [--skill ..]... [--workers human|agent|any] [--deadline 2026-12-01] [--answer k=v]...
  work posted [--connector <id>]                   jobs you posted and where each stands
  work offers <posting-id>                         the bids, applications or entries on one of your postings
  work award <posting-id> <offer-id>               give the work to one offer
  work review <posting-id> accept|changes|reject [--note ..]
  work pay <posting-id> [fund|release] [--offer <id>] [--amount n --currency USD] [--confirm <token>]   first call shows what would move; --confirm does it
  work cancel <posting-id> [--note ..]
  work connect [<id>] [--email ..] [--name ..] [--handle ..]   what each platform needs; registers where the platform allows agents to
  work connect <id> --set NAME=value...            keep a key (checked against the platform first)
  work disconnect <id>                             forget a kept key
  work login <id> [--url <mcp url>] [--scope ..]   sign in to a linked MCP server (OAuth, browser)
  work logout <id>                                 forget that sign-in
  work mcp inspect <id|url>                        list a linked server's tools
  work mcp call <id> <tool> [json]                 call one tool on a linked server, as you
  work draft <url> [--id <id>] [--query ..] [--out <dir>]  draft a profile for an MCP server
  work mcp                                         MCP server over stdio
  work serve [--port 8787] [--host 127.0.0.1] [--token ..]   MCP server over HTTP (one person's env)
  work index [--connector <id>]...                 gather the catalog's public listings into the search index
  work trace [--name ..] [--out <file>] -- <command>   run a workflow and record every call it makes
  work watch [--port 8791] [--export <dir>]        a local page that follows and replays recorded runs

Every command takes --json. One command: work help <command>. Version: work --version. Keys: KARIAA_API_KEY and the platforms' own (see .env.example, or work connect).
Ids look like kariaa:3f2a… or remotive:1923456; keep them as returned.`;

type Options = ParseArgsConfig["options"];

/** The repo (or installed package) root, two levels above this file in both src/ and dist/. */
const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const COMMON: Options = {
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
};

const OPTIONS: Record<string, Options> = {
  connectors: {},
  search: {
    in: { type: "string" },
    remote: { type: "boolean", default: false },
    kind: { type: "string" },
    category: { type: "string" },
    media: { type: "string" },
    connector: { type: "string", multiple: true },
    limit: { type: "string" },
    "direct-apply": { type: "boolean", default: false },
    "pay-min": { type: "string" },
  },
  get: {},
  apply: { answer: { type: "string", multiple: true }, note: { type: "string" }, rate: { type: "string" } },
  verify: { text: { type: "string", multiple: true }, answer: { type: "string", multiple: true } },
  add: { text: { type: "string" }, url: { type: "string" }, name: { type: "string" }, mime: { type: "string" } },
  remove: {},
  submit: { note: { type: "string" } },
  status: {},
  mine: { connector: { type: "string" } },
  link: {},
  me: {},
  profile: { connector: { type: "string" } },
  connect: {
    email: { type: "string" },
    name: { type: "string" },
    handle: { type: "string" },
    description: { type: "string" },
    set: { type: "string", multiple: true },
  },
  disconnect: {},
  login: { url: { type: "string" }, scope: { type: "string" }, port: { type: "string" } },
  logout: {},
  draft: { id: { type: "string" }, name: { type: "string" }, query: { type: "string" }, out: { type: "string" } },
  earnings: { connector: { type: "string" } },
  payout: {
    connector: { type: "string" },
    method: { type: "string" },
    to: { type: "string" },
    amount: { type: "string" },
    note: { type: "string" },
  },
  post: {
    connector: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    budget: { type: "string" },
    currency: { type: "string" },
    accept: { type: "string", multiple: true },
    skill: { type: "string", multiple: true },
    workers: { type: "string" },
    deadline: { type: "string" },
    answer: { type: "string", multiple: true },
  },
  posted: { connector: { type: "string" } },
  offers: {},
  award: {},
  review: { note: { type: "string" } },
  pay: {
    offer: { type: "string" },
    amount: { type: "string" },
    currency: { type: "string" },
    note: { type: "string" },
    confirm: { type: "string" },
  },
  cancel: { note: { type: "string" } },
  mcp: {},
  index: { connector: { type: "string", multiple: true } },
  serve: { port: { type: "string" }, host: { type: "string" }, token: { type: "string" } },
  trace: { name: { type: "string" }, out: { type: "string" } },
  watch: { port: { type: "string" }, host: { type: "string" }, export: { type: "string" } },
  help: {},
};

/** The first sentence of a message, cut to a line a terminal can show. */
function firstSentence(message: string): string {
  const first = message.split(/(?<=[.!?])\s/u)[0] ?? message;
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new ProtocolError("invalid_input", `Missing ${what}. Run \`work help\`.`);
  return value;
}

function keyValues(pairs: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new ProtocolError("invalid_input", `Expected key=value, got ${JSON.stringify(pair)}.`);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else out[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return out;
}

function profileFields(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(keyValues(pairs))) {
    if (Array.isArray(value)) out[key] = value;
    else if (key === "occupation")
      out[key] = value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    else out[key] = value;
  }
  return out;
}

/** Searches use the local index when `work index` has built one; WORK_INDEX=off ignores it. */
function indexOption(env: NodeJS.ProcessEnv): { index?: LocalIndex } {
  if (env.WORK_INDEX === "off") return {};
  const index = localIndexIfBuilt(env);
  return index ? { index } : {};
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  if (!io.env) loadDotEnv();
  const env = io.env ?? process.env;
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;
  const options = OPTIONS[command];
  if (!options) {
    io.stderr(`Unknown command ${JSON.stringify(command)}.\n${USAGE}\n`);
    return 1;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: rest, options: { ...COMMON, ...options }, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const values = parsed.values as Record<string, string | boolean | string[] | undefined>;
  const positionals = parsed.positionals;
  const asJson = values.json === true;
  if (values.version === true) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (command === "help" || values.help === true) {
    // `work help search` and `work search --help` show that command's lines only.
    const topic = command === "help" ? positionals[0] : command;
    const lines = topic ? USAGE.split("\n").filter((line) => line.startsWith(`  work ${topic} `) || line.trim() === `work ${topic}`) : [];
    io.stdout(lines.length ? `${lines.join("\n")}\n\nEvery command takes --json. All commands: work help\n` : `${USAGE}\n`);
    return 0;
  }

  if (command === "mcp" && positionals[0] !== "inspect" && positionals[0] !== "call") {
    const { runStdio } = await import("../mcp/stdio.js");
    await runStdio(env);
    return 0;
  }

  if (command === "trace") {
    if (positionals.length === 0) {
      io.stderr("Give the command to run: work trace -- npx tsx workflows/my-workflow/run.ts\n");
      return 1;
    }
    const { runTraced, renderSummary } = await import("./trace.js");
    const result = await runTraced({
      command: positionals,
      env,
      ...(typeof values.name === "string" ? { name: values.name } : {}),
      ...(typeof values.out === "string" ? { out: values.out } : {}),
    });
    if (asJson) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else io.stdout(`\n${renderSummary(result.summary)}\n  trace      ${path.relative(process.cwd(), result.file)}\n\nSee it: work watch\n`);
    return result.exit;
  }

  if (command === "watch") {
    const { listenWatch, exportWatch } = await import("./watch.js");
    if (typeof values.export === "string") {
      const done = exportWatch({ cwd: process.cwd(), packageRoot: CLI_ROOT, out: path.resolve(values.export) });
      io.stdout(asJson ? `${JSON.stringify(done)}\n` : `Wrote the page and ${done.runs} run${done.runs === 1 ? "" : "s"} to ${done.out}\n`);
      return 0;
    }
    let bound;
    try {
      bound = await listenWatch({
        cwd: process.cwd(),
        packageRoot: CLI_ROOT,
        ...(typeof values.port === "string" ? { port: Number(values.port) } : {}),
        ...(typeof values.host === "string" ? { host: values.host } : {}),
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      io.stderr(
        code === "EADDRINUSE"
          ? "That port is in use (another `work watch`?). Pick another: work watch --port 8792\n"
          : `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    io.stderr(`Watching runs at ${bound.url} (Ctrl+C to stop)\n`);
    await new Promise<void>((resolve) => {
      const stop = () => void bound.close().then(resolve);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }

  let protocol = io.protocol;
  const owned = !protocol;
  if (!protocol) {
    protocol = await createProtocol({
      env,
      allowLocalFiles: true,
      cache: new JobCache({ file: defaultCacheFile(env) }),
      credentialStore: fileCredentialStore(env),
      ...(command === "pay" ? { confirmSecret: persistedConfirmSecret(env) } : {}),
      ...(command !== "index" ? indexOption(env) : {}),
      // Only a long-running server sees enough searches to judge a platform's health.
      ...(command === "serve"
        ? {
            health: new ConnectorHealth({
              log: (event, data) =>
                io.stderr(`${JSON.stringify({ event, ...data })}
`),
            }),
          }
        : {}),
    });
  }

  const print = (data: unknown, text: string) => io.stdout(asJson ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);

  try {
    switch (command) {
      case "connectors": {
        const connectors = protocol.connectors();
        print({ connectors }, renderConnectors(connectors));
        break;
      }
      case "search": {
        const query: SearchQuery = {};
        if (positionals.length) query.query = positionals.join(" ");
        if (typeof values.in === "string") query.location = values.in;
        if (values.remote === true) query.remote = true;
        if (values.kind !== undefined) {
          if (values.kind !== "task" && values.kind !== "listing") throw new ProtocolError("invalid_input", "--kind is task or listing.");
          query.kind = values.kind;
        }
        if (values.category !== undefined) {
          if (!(CONNECTOR_CATEGORIES as readonly string[]).includes(String(values.category)))
            throw new ProtocolError("invalid_input", `--category is one of ${CONNECTOR_CATEGORIES.join(", ")}.`);
          query.category = values.category as ConnectorCategory;
        }
        if (values["direct-apply"] === true) query.direct_apply = true;
        if (typeof values["pay-min"] === "string") {
          const payMin = Number(values["pay-min"]);
          if (!Number.isFinite(payMin) || payMin < 0) throw new ProtocolError("invalid_input", "--pay-min is a number of 0 or more.");
          query.pay_min = payMin;
        }
        if (typeof values.media === "string")
          query.media = values.media
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean) as SearchQuery["media"];
        if (Array.isArray(values.connector) && values.connector.length) query.connectors = values.connector as string[];
        if (typeof values.limit === "string") query.limit = Number(values.limit);
        const result = await protocol.search(query);
        const lines = result.jobs.length ? result.jobs.map((job: Job) => renderJobLine(job)) : ["No matches."];
        if (result.more && result.jobs.length) lines.push("", "More available: narrow the search or raise --limit.");
        // An empty default search may only mean the platforms that have it were not asked.
        if (!result.jobs.length && !query.connectors) {
          const unasked = protocol
            .connectors()
            .filter((c) => c.opt_in && c.stages.includes("search") && (c.auth.configured || !c.auth.required))
            .map((c) => c.id);
          if (unasked.length)
            lines.push(
              "",
              `Asked only when named: ${unasked.join(", ")}. Try --connector <id>, or WORK_CATALOG=all to ask every platform.`,
            );
          // A platform that was left out for want of a key says which key.
          const keyless = protocol
            .connectors()
            .filter((c) => !c.opt_in && c.stages.includes("search") && c.auth.required && !c.auth.configured)
            .map((c) => `${c.id} (${(c.auth.env ?? []).join(" + ")})`);
          if (keyless.length) lines.push("", `Not asked without a key: ${keyless.join(", ")}. Set it in .env, or run work connect.`);
        }
        // One short line per source that did not answer; the full message is in --json.
        for (const p of result.partial) lines.push(`${p.connector} did not answer: ${p.error.code}: ${firstSentence(p.error.message)}`);
        print(result, lines.join("\n"));
        break;
      }
      case "get": {
        const job = await protocol.get(need(positionals[0], "<id>"));
        print(job, renderJob(job));
        break;
      }
      case "apply": {
        const answers = Array.isArray(values.answer) && values.answer.length ? keyValues(values.answer as string[]) : undefined;
        const application = await protocol.apply(need(positionals[0], "<job-id>"), {
          ...(answers ? { answers } : {}),
          ...(typeof values.note === "string" ? { note: values.note } : {}),
          ...(typeof values.rate === "string" ? { preferred_rate: values.rate } : {}),
        });
        print(application, renderApplication(application));
        break;
      }
      case "verify": {
        const jobId = need(positionals[0], "<job-id>");
        const work = [
          ...positionals.slice(1).map((file) => ({ file: { path: file } })),
          ...(Array.isArray(values.text) ? (values.text as string[]).map((text) => ({ text })) : []),
        ];
        const answers = Array.isArray(values.answer) && values.answer.length ? keyValues(values.answer as string[]) : undefined;
        // Screening answers can be checked without any work, the same as the library and the verify_work tool.
        if (work.length === 0 && !answers)
          throw new ProtocolError(
            "invalid_input",
            "Give files to check, --text for a written answer, or --answer to check screening answers.",
          );
        const verification = await protocol.verify(jobId, work, answers);
        print(verification, renderVerification(verification));
        return verification.outcome === "pass" ? 0 : verification.outcome === "fail" ? 2 : 3;
      }
      case "add": {
        const applicationId = need(positionals[0], "<app-id>");
        const file = positionals[1];
        const receipt = await protocol.upload(applicationId, {
          ...(typeof values.text === "string" ? { text: values.text } : {}),
          ...(file || typeof values.url === "string"
            ? {
                file: {
                  ...(file ? { path: file } : {}),
                  ...(typeof values.url === "string" ? { url: values.url } : {}),
                  ...(typeof values.name === "string" ? { name: values.name } : {}),
                  ...(typeof values.mime === "string" ? { mime_type: values.mime } : {}),
                },
              }
            : {}),
        });
        print(receipt, renderReceipt(receipt));
        break;
      }
      case "remove": {
        const receipt = await protocol.remove(need(positionals[0], "<app-id>"), need(positionals[1], "<file-id>"));
        print(receipt, renderReceipt(receipt));
        break;
      }
      case "submit": {
        const application = await protocol.submit(
          need(positionals[0], "<app-id>"),
          typeof values.note === "string" ? { note: values.note } : {},
        );
        print(application, renderApplication(application));
        break;
      }
      case "status": {
        const application = await protocol.status(need(positionals[0], "<app-id>"));
        print(application, renderApplication(application));
        break;
      }
      case "mine": {
        const result = await protocol.list(typeof values.connector === "string" ? values.connector : undefined);
        const lines = result.applications.length
          ? result.applications.map((a: Application) => renderApplication(a))
          : ["No applications yet."];
        for (const p of result.partial) lines.push(`${p.connector} failed: ${p.error.code}: ${p.error.message}`);
        print(result, lines.join("\n\n"));
        break;
      }
      case "link": {
        const link = await protocol.link(need(positionals[0], "<app-id>"));
        print(link, `${link.url}${link.expires_at ? `\nExpires ${link.expires_at}` : ""}`);
        break;
      }
      case "me": {
        const accounts = await protocol.accounts();
        print(
          { accounts },
          accounts.length
            ? accounts.map(renderAccount).join("\n")
            : "Not signed in anywhere yet. Set KARIAA_API_KEY in .env (a key from https://www.kariaa.com/datahouse/connect), or run work connect to see what each platform needs.",
        );
        break;
      }
      case "profile": {
        const connector = need(typeof values.connector === "string" ? values.connector : undefined, "--connector <id>");
        if (!positionals.length)
          throw new ProtocolError("invalid_input", 'Give fields as name=value, for example location="Accra, Ghana".');
        const account = { connector, ...(await protocol.updateAccount(connector, profileFields(positionals))) };
        print(account, renderAccount(account));
        break;
      }
      case "connect": {
        const id = positionals[0];
        if (Array.isArray(values.set) && values.set.length) {
          const pairs = keyValues(values.set as string[]);
          const connection = await protocol.saveCredentials(
            need(id, "<id>"),
            Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, Array.isArray(v) ? v[v.length - 1] : v])),
          );
          print(connection, renderConnection(connection));
          break;
        }
        const input = {
          ...(typeof values.email === "string" ? { email: values.email } : {}),
          ...(typeof values.name === "string" ? { name: values.name } : {}),
          ...(typeof values.handle === "string" ? { handle: values.handle } : {}),
          ...(typeof values.description === "string" ? { description: values.description } : {}),
        };
        const connections = id ? [await protocol.connect(id, input)] : await protocol.connections();
        print({ connections }, connections.map(renderConnection).join("\n\n"));
        break;
      }
      case "disconnect": {
        const id = protocol.connector(need(positionals[0], "<id>")).id;
        const removed = await fileCredentialStore(env).forget!(id);
        print({ id, removed }, removed ? `Forgot the key kept for ${id}.` : `No key kept for ${id}.`);
        break;
      }
      case "login": {
        const id = need(positionals[0], "<id>");
        const { loginMcp } = await import("../core/oauthLogin.js");
        let url = typeof values.url === "string" ? values.url : undefined;
        let scope = typeof values.scope === "string" ? values.scope : undefined;
        if (!url) {
          const connector = protocol.connector(id);
          if (!isMcpLinked(connector) || connector.profile.transport.type !== "http") {
            throw new ProtocolError("invalid_input", `${id} is not a linked HTTP MCP server; pass --url.`);
          }
          url = connector.profile.transport.url;
          scope ??= connector.profile.auth.type === "oauth" ? connector.profile.auth.scope : undefined;
        }
        const result = await loginMcp({
          id,
          url,
          scope,
          env,
          port: typeof values.port === "string" ? Number(values.port) : undefined,
          log: (t) => io.stderr(`${t}\n`),
        });
        print(result, `Signed in to ${id}: ${result.tools} tools. Tokens in ${result.file}.`);
        break;
      }
      case "logout": {
        const id = need(positionals[0], "<id>");
        const { clearOAuth } = await import("../core/oauth.js");
        const removed = clearOAuth(id, env);
        print({ id, removed }, removed ? `Signed out of ${id}.` : `No sign-in stored for ${id}.`);
        break;
      }
      case "mcp": {
        const sub = positionals[0];
        const target = need(positionals[1], sub === "call" ? "<id> <tool>" : "<id|url>");
        const ctx = { credentials: {}, fetch: globalThis.fetch.bind(globalThis), signal: new AbortController().signal, log: () => {} };
        if (sub === "inspect") {
          if (/^https?:\/\//u.test(target)) {
            const { sharedMcpPool } = await import("../core/mcpClient.js");
            const tools = await sharedMcpPool().listTools({ type: "http", url: target }, { label: target });
            print(
              { url: target, tools },
              tools
                .map(
                  (t) =>
                    `- ${t.name}(${Object.keys((t.inputSchema as { properties?: object })?.properties ?? {}).join(", ")})\n    ${(t.description ?? "").replace(/\s+/gu, " ").slice(0, 200)}`,
                )
                .join("\n"),
            );
            break;
          }
          const connector = protocol.connector(target);
          if (!isMcpLinked(connector)) throw new ProtocolError("invalid_input", `${target} is not a linked MCP server.`);
          const tools = await connector.listTools({ ...ctx, credentials: credentialsFor(connector, env) });
          print(
            { id: target, tools },
            tools.map((t) => `- ${t.name}(${t.inputs.join(", ")})\n    ${t.description.replace(/\s+/gu, " ").slice(0, 200)}`).join("\n"),
          );
          break;
        }
        const tool = need(positionals[2], "<tool>");
        const connector = protocol.connector(target);
        if (!isMcpLinked(connector)) throw new ProtocolError("invalid_input", `${target} is not a linked MCP server.`);
        let args: Record<string, unknown> = {};
        if (positionals[3]) {
          try {
            args = JSON.parse(positionals[3]) as Record<string, unknown>;
          } catch {
            throw new ProtocolError("invalid_input", 'The arguments must be JSON, like \'{"name":"…"}\'.');
          }
        }
        const result = await connector.callTool(tool, args, { ...ctx, credentials: credentialsFor(connector, env) });
        print(result, typeof result.text === "string" ? result.text : JSON.stringify(result, null, 2));
        break;
      }
      case "draft": {
        const url = need(positionals[0], "<url>");
        const { sharedMcpPool } = await import("../core/mcpClient.js");
        const { draftProfile, renderProfileModule, writeDraft } = await import("../core/mcp/draft.js");
        const pool = sharedMcpPool();
        const spec = { type: "http" as const, url };
        const tools = await pool.listTools(spec, { label: url });
        const id =
          typeof values.id === "string" ? values.id : (new URL(url).hostname.replace(/^(www|mcp|api)\./u, "").split(".")[0] ?? "linked");
        let sampleSearch: Record<string, unknown> | undefined;
        if (typeof values.query === "string") {
          const guess = draftProfile({ id, url, tools });
          const result = await pool.call(
            spec,
            guess.tools.search.name,
            {
              ...Object.fromEntries(
                Object.entries(guess.tools.search.args)
                  .map(([k, v]) => [k, v === "$.query" ? values.query : v === "$.limit" ? 5 : undefined])
                  .filter(([, v]) => v !== undefined),
              ),
            },
            { label: url },
          );
          const { toolResultJson } = await import("../core/mcpClient.js");
          sampleSearch = result.isError ? undefined : toolResultJson(result, url, guess.tools.search.name);
        }
        const profile = draftProfile({ id, url, tools, sampleSearch, name: typeof values.name === "string" ? values.name : undefined });
        if (typeof values.out === "string") {
          const dir = path.join(values.out, id);
          const inRepo = path.resolve(dir).startsWith(path.resolve(CLI_ROOT, "src", "connectors"));
          const written = writeDraft(dir, profile, { importFrom: inRepo ? "../../core/mcp/profile.js" : "kariaa-agents", source: url });
          print(
            { written, profile },
            `Draft written: ${written.join(", ")}. Check every TODO, then register the connector in src/connectors/index.ts.`,
          );
        } else {
          print(profile, renderProfileModule(profile, { source: url }));
        }
        break;
      }
      case "earnings": {
        const result = await protocol.earnings(typeof values.connector === "string" ? values.connector : undefined);
        const lines = result.earnings.length ? result.earnings.map(renderEarnings) : ["No connector here reports earnings."];
        for (const p of result.partial) lines.push(`${p.connector} failed: ${p.error.code}: ${p.error.message}`);
        print(result, lines.join("\n"));
        break;
      }
      case "payout": {
        const connector = need(typeof values.connector === "string" ? values.connector : undefined, "--connector <id>");
        const method = need(typeof values.method === "string" ? values.method : undefined, "--method <paypal|venmo|...>");
        const payout = await protocol.requestPayout(connector, {
          method,
          ...(typeof values.amount === "string" ? { amount: Number(values.amount) } : {}),
          ...(typeof values.to === "string" ? { destination: values.to } : {}),
          ...(typeof values.note === "string" ? { note: values.note } : {}),
        });
        print(payout, renderPayout(payout));
        break;
      }
      case "post": {
        const budget = Number(values.budget);
        if (!Number.isFinite(budget) || budget <= 0 || typeof values.currency !== "string")
          throw new ProtocolError("invalid_input", "Give the budget and its currency: --budget 30 --currency USD.");
        if (values.workers !== undefined && !["human", "agent", "any"].includes(String(values.workers)))
          throw new ProtocolError("invalid_input", "--workers is human, agent or any.");
        const posting = await protocol.post(need(typeof values.connector === "string" ? values.connector : undefined, "--connector <id>"), {
          title: need(typeof values.title === "string" ? values.title : undefined, "--title"),
          description: need(typeof values.description === "string" ? values.description : undefined, "--description"),
          budget: { amount: budget, currency: values.currency },
          ...(Array.isArray(values.accept) && values.accept.length ? { acceptance: values.accept as string[] } : {}),
          ...(Array.isArray(values.skill) && values.skill.length ? { skills: values.skill as string[] } : {}),
          ...(typeof values.workers === "string" ? { workers: values.workers as "human" | "agent" | "any" } : {}),
          ...(typeof values.deadline === "string" ? { deadline: values.deadline } : {}),
          ...(Array.isArray(values.answer) && values.answer.length ? { answers: keyValues(values.answer as string[]) } : {}),
        });
        print(posting, renderPosting(posting));
        break;
      }
      case "posted": {
        const result = await protocol.postings(typeof values.connector === "string" ? values.connector : undefined);
        const canPost = protocol.connectors().some((c) => c.stages.includes("postings"));
        const lines = result.postings.length
          ? result.postings.map(renderPosting)
          : [canPost ? "Nothing posted yet." : "No platform here supports posting work yet. See docs/hire.md for how to add one."];
        for (const p of result.partial) lines.push(`${p.connector} did not answer: ${p.error.code}: ${firstSentence(p.error.message)}`);
        print(result, lines.join("\n\n"));
        break;
      }
      case "offers": {
        const result = await protocol.offers(need(positionals[0], "<posting-id>"));
        print(
          result,
          [renderPosting(result.posting), "", ...(result.offers.length ? result.offers.map(renderOffer) : ["No offers yet."])].join("\n"),
        );
        break;
      }
      case "award": {
        const posting = await protocol.award(need(positionals[0], "<posting-id>"), need(positionals[1], "<offer-id>"));
        print(posting, renderPosting(posting));
        break;
      }
      case "review": {
        const word = need(positionals[1], "accept, changes or reject");
        const decision =
          word === "accept"
            ? "accept"
            : word === "changes" || word === "request_changes"
              ? "request_changes"
              : word === "reject"
                ? "reject"
                : null;
        if (!decision) throw new ProtocolError("invalid_input", "Say accept, changes or reject.");
        const posting = await protocol.review(need(positionals[0], "<posting-id>"), {
          decision,
          ...(typeof values.note === "string" ? { note: values.note } : {}),
        });
        print(posting, renderPosting(posting));
        break;
      }
      case "pay": {
        const action = positionals[1];
        if (action !== undefined && action !== "fund" && action !== "release")
          throw new ProtocolError("invalid_input", "Say fund or release.");
        const amount = typeof values.amount === "string" ? Number(values.amount) : undefined;
        if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0))
          throw new ProtocolError("invalid_input", "--amount is a number above 0.");
        if ((amount === undefined) !== (typeof values.currency !== "string"))
          throw new ProtocolError("invalid_input", "--amount and --currency go together: --amount 30 --currency USD.");
        const payment = await protocol.pay(need(positionals[0], "<posting-id>"), {
          ...(action ? { action } : {}),
          ...(typeof values.offer === "string" ? { offer: values.offer } : {}),
          ...(amount !== undefined ? { amount: { amount, currency: String(values.currency) } } : {}),
          ...(typeof values.note === "string" ? { note: values.note } : {}),
          ...(typeof values.confirm === "string" ? { confirm: values.confirm } : {}),
        });
        print(payment, renderPayment(payment));
        break;
      }
      case "cancel": {
        const posting = await protocol.cancelPosting(
          need(positionals[0], "<posting-id>"),
          typeof values.note === "string" ? { note: values.note } : {},
        );
        print(posting, renderPosting(posting));
        break;
      }
      case "index": {
        const embedder = openAiEmbedder(env.OPENAI_API_KEY);
        const where = defaultIndexFile(env);
        const store = new LocalIndex({ file: where, ...(embedder ? { embedder } : {}) });
        const reports = await indexCatalog({
          protocol,
          store,
          rates: await fetchUsdRates(),
          ...(embedder ? { embedder } : {}),
          ...(Array.isArray(values.connector) && values.connector.length ? { connectors: values.connector as string[] } : {}),
        });
        const lines = reports.map(
          (r) =>
            `${r.connector}: ${r.error ? `failed: ${r.error}` : `${r.seen} listings, ${r.changed} new or changed, ${r.closed} closed`}`,
        );
        lines.push("", `Index: ${where}${embedder ? "" : " (full text only; set OPENAI_API_KEY for semantic matching)"}`);
        print({ reports, where }, lines.join("\n"));
        break;
      }
      case "serve": {
        const { listen } = await import("../mcp/http.js");
        const port = typeof values.port === "string" ? Number(values.port) : Number(env.PORT) || 8787;
        const host = typeof values.host === "string" ? values.host : env.HOST || "127.0.0.1";
        const token = typeof values.token === "string" ? values.token : env.WORK_HTTP_TOKEN?.trim() || undefined;
        const bound = await listen({
          protocol,
          port,
          host,
          token,
          log: (event, data) => io.stderr(`${JSON.stringify({ event, ...data })}\n`),
        });
        io.stderr(
          `kariaa-agents ${VERSION} listening on http://${bound.host}:${bound.port}/mcp${token ? " (bearer token required)" : ""}\n`,
        );
        await new Promise<void>((resolve) => {
          const stop = () => void bound.close().then(resolve);
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        break;
      }
      default:
        io.stderr(`${USAGE}\n`);
        return 1;
    }
    return 0;
  } catch (error) {
    const err = error instanceof ProtocolError ? error : toProtocolError(error);
    if (asJson) io.stdout(`${JSON.stringify(err.toJSON(), null, 2)}\n`);
    else {
      const extra = err.details && Object.keys(err.details).length ? ` ${JSON.stringify(err.details)}` : "";
      io.stderr(`${err.code}: ${err.message}${extra}\n`);
    }
    return 1;
  } finally {
    if (owned) await protocol.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  // Piped into a command that stops reading early (head, Select-Object -First): end quietly.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });
  main(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    });
}
