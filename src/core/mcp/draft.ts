/**
 * `work link <url>`: a first profile for an MCP server, guessed from its tool
 * names, inputs and (when a sample search ran) its result shape. A person
 * finishes it: the guesses are marked TODO.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpProfile } from "./profile.js";

type Guess = { tool: Tool; stage: keyof McpProfile["tools"] };

const STAGE_PATTERNS: Array<[keyof McpProfile["tools"], RegExp]> = [
  ["search", /^(search|find|browse|list|query)[_-]?(jobs?|tasks?|gigs?|bount(y|ies)|listings?|projects?|roles?|open)/iu],
  ["get", /^(get|fetch|read)[_-]?(job|task|gig|bounty|listing|project|role)s?(_details?)?$|^job[_-]?details/iu],
  ["apply", /^(apply|express_interest|submit_bid|bid|place_bid|claim|take)/iu],
  ["submit", /^(submit_result|submit_work|deliver|request_close|complete)/iu],
  ["status", /^(get_(application|submission|bid)|application_status|submission_status)/iu],
  ["list", /^(my_|get_my_|list_my_)(jobs|applications|submissions|bids|activity|tasks)/iu],
  ["earnings", /(earnings|payments|balance|payouts|wallet)/iu],
  ["account", /^(get_me|whoami|me|get_my_profile|profile)$/iu],
];

const FIELD_GUESSES: Record<string, string[]> = {
  id: ["id", "job_id", "task_id", "uid", "guid", "slug", "bounty_id", "listing_id"],
  title: ["title", "name", "job_title", "role"],
  org: ["company", "company_name", "org", "employer", "poster_name", "companyName", "author.name"],
  "location.text": ["location", "place", "city", "candidate_required_location", "jobGeo"],
  "location.remote": ["remote", "is_remote", "isRemote"],
  "pay.text": ["salary", "pay", "compensation", "reward", "budget", "rate", "asking_price", "reward_usd"],
  summary: ["summary", "excerpt", "description", "preview_description"],
  url: ["url", "link", "apply_url", "applyUrl", "job_url", "html_url"],
  posted_at: ["posted", "posted_at", "created_at", "publication_date", "pubDate", "date"],
};

/** searchQuery, search-query and search_query all read as search_query. */
function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/-/gu, "_")
    .toLowerCase();
}

type DraftArg = string | { from: string; transform: "list" };

function argGuesses(tool: Tool): Record<string, DraftArg> {
  const props = (tool.inputSchema as { properties?: Record<string, { type?: unknown }> })?.properties ?? {};
  const args: Record<string, DraftArg> = {};
  for (const [prop, schema] of Object.entries(props)) {
    const p = snake(prop);
    const type = schema && typeof schema === "object" ? schema.type : undefined;
    const isArray = type === "array" || (Array.isArray(type) && type.includes("array"));
    const input = (path: string): DraftArg => (isArray ? { from: path, transform: "list" } : path);
    if (/^(q|query|search|search_query|search_term|search_text|query_text|term|keyword|keywords|text|title_keywords|role|what)$/u.test(p))
      args[prop] = input("$.query");
    else if (/^(location|locations|loc|where|city|cities|country|countries|region|place)$/u.test(p)) args[prop] = input("$.location");
    else if (/^(remote|remote_only|is_remote)$/u.test(p)) args[prop] = "$.remote";
    else if (/^(limit|count|page_size|per_page|size|max|max_results|results|num)$/u.test(p)) args[prop] = "$.limit";
    else if (/(^|_)(id|uid|guid|slug)$/u.test(p)) args[prop] = "$.id";
  }
  return args;
}

/** When several tools fit a stage, work beats directories: jobs and tasks before companies or listings. */
const WORK_NOUNS = ["job", "task", "gig", "bount", "project", "role", "opportunit", "listing", "open"];
function workRank(name: string): number {
  const lower = name.toLowerCase();
  const index = WORK_NOUNS.findIndex((noun) => lower.includes(noun));
  return index < 0 ? WORK_NOUNS.length : index;
}

function fieldGuesses(sample: Record<string, unknown> | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  const keys = sample ? Object.keys(sample) : [];
  for (const [field, candidates] of Object.entries(FIELD_GUESSES)) {
    const hit = candidates.find((c) => keys.includes(c) || (c.includes(".") && keys.includes(c.split(".")[0]!)));
    map[field] = hit ? `$.${hit}` : `$.TODO_${field.replace(".", "_")}`;
  }
  if (!sample) return map;
  return Object.fromEntries(Object.entries(map).filter(([field, path]) => field === "id" || field === "title" || !path.includes("TODO")));
}

function firstArrayPath(result: Record<string, unknown> | undefined): { path: string; sample?: Record<string, unknown> } {
  if (!result) return { path: "$.TODO_items" };
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && value.length) {
      const first = value[0];
      return { path: `$.${key}`, ...(first && typeof first === "object" ? { sample: first as Record<string, unknown> } : {}) };
    }
  }
  return { path: "$.TODO_items" };
}

/** A draft profile for a server, from its tools and an optional sample search result. */
export function draftProfile(options: {
  id: string;
  url: string;
  tools: Tool[];
  sampleSearch?: Record<string, unknown>;
  name?: string;
}): McpProfile {
  const guesses: Guess[] = [];
  for (const [stage, pattern] of STAGE_PATTERNS) {
    if (guesses.some((g) => g.stage === stage)) continue;
    const tool = options.tools.filter((t) => pattern.test(t.name)).sort((a, b) => workRank(a.name) - workRank(b.name))[0];
    if (tool) guesses.push({ tool, stage });
  }
  const search = guesses.find((g) => g.stage === "search")?.tool ?? options.tools[0];
  const { path, sample } = firstArrayPath(options.sampleSearch);
  const tools: McpProfile["tools"] = {
    search: {
      name: search?.name ?? "TODO_search",
      args: search ? argGuesses(search) : {},
      items: path,
      map: fieldGuesses(sample),
      filter: [],
    },
  };
  for (const guess of guesses) {
    if (guess.stage === "search") continue;
    const args = argGuesses(guess.tool);
    if (guess.stage === "get") tools.get = { name: guess.tool.name, args, map: fieldGuesses(sample) };
    else if (guess.stage === "apply")
      tools.apply = { name: guess.tool.name, args, map: { id: { input: "$.id" }, stage: { const: "applied" } } };
    else if (guess.stage === "submit")
      tools.submit = { name: guess.tool.name, args: { ...args, TODO_content: "$.note" }, map: { stage: { const: "in_review" } } };
    else if (guess.stage === "status") tools.status = { name: guess.tool.name, args, map: { id: "$.id", stage: "$.status" } };
    else if (guess.stage === "list")
      tools.list = { name: guess.tool.name, args: {}, items: "$.TODO_items", map: { id: "$.id", job_id: "$.job_id", stage: "$.status" } };
    else if (guess.stage === "earnings")
      tools.earnings = {
        name: guess.tool.name,
        args: {},
        map: { "balance.amount": "$.TODO_balance", "balance.currency": { const: "USD" } },
      };
    else if (guess.stage === "account") tools.account = { name: guess.tool.name, args: {}, map: { label: "$.TODO_username" } };
  }
  const host = new URL(options.url).hostname.replace(/^(www|mcp|api)\./u, "");
  return {
    id: options.id,
    name: options.name ?? host,
    description: `TODO: what ${host} offers, where, and which stages work.`,
    homepage: `https://${host}`,
    kinds: ["listing"],
    transport: { type: "http", url: options.url },
    auth: { type: "none" },
    tools,
    notes: "Draft made by `work link`. Check every TODO, the argument names and the result paths against `work mcp inspect`.",
  };
}

/** `agent-bounty-board` → `agentBountyBoard`: the export name a connector folder uses. */
export function camelId(id: string): string {
  return id.replace(/-([a-z0-9])/gu, (_match, c: string) => c.toUpperCase());
}

export type RenderOptions = {
  /** Where `McpProfileInput` and `defineMcpConnector` come from. Default the package name. */
  importFrom?: string;
  /** The server the draft came from, for the header comment. */
  source?: string;
};

/** The profile as the TypeScript module the repo keeps in `src/connectors/<id>/profile.ts`. */
export function renderProfileModule(profile: McpProfile, options: RenderOptions = {}): string {
  const from = options.importFrom ?? "kariaa-agents";
  const origin = options.source ? ` from ${options.source}` : "";
  return `import type { McpProfileInput } from "${from}";\n\n/** Drafted by \`work draft\`${origin}. Check every TODO; docs/mcp-profiles.md explains each field. */\nexport const profile = ${JSON.stringify(profile, null, 2)} satisfies McpProfileInput;\n`;
}

/** Writes `profile.ts` and, when it does not exist yet, `index.ts` into `dir`. Returns the files written. */
export function writeDraft(dir: string, profile: McpProfile, options: RenderOptions = {}): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const profileFile = path.join(dir, "profile.ts");
  writeFileSync(profileFile, renderProfileModule(profile, options));
  written.push(profileFile);
  const indexFile = path.join(dir, "index.ts");
  if (!existsSync(indexFile)) {
    const from = options.importFrom ?? "kariaa-agents";
    writeFileSync(
      indexFile,
      `import { defineMcpConnector } from "${from}";\nimport { profile } from "./profile.js";\n\nexport const ${camelId(profile.id)} = defineMcpConnector(profile);\n`,
    );
    written.push(indexFile);
  }
  return written;
}
