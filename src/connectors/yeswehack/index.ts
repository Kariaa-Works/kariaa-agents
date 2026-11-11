/**
 * YesWeHack: public bug bounty and vulnerability disclosure programs, through the
 * documented program endpoints of api.yeswehack.com (no key). Reports are submitted
 * on yeswehack.com; the API's personal access tokens are issued to program owners
 * and managers only, so this connector finds and reads programs.
 */
import { defineConnector, type ConnectorContext } from "../../core/connector.js";
import { ProtocolError } from "../../core/errors.js";
import { fetchJson } from "../../core/http.js";
import { applyFilters, iso, num, str, strings } from "../../core/jsonBoard.js";
import { stripHtml, truncate } from "../../core/text.js";
import type { NativeJob } from "../../core/types.js";

export const YESWEHACK_API = "https://api.yeswehack.com";
const ID = "yeswehack";
const LABEL = "YesWeHack";
const CACHE_MS = 10 * 60_000;
/** Pages of 100 (the API's maximum) read from the program list. */
const MAX_PAGES = 3;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);

const APPLY_HINT =
  "Test the scopes on the program page within its rules, then submit a report on yeswehack.com with a YesWeHack hunter account; reports go only through the platform.";
const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const ASSET_TIERS = ["very_low", "low", "medium", "high", "critical"] as const;

const fmt = (n: number) => n.toLocaleString("en-US");
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

function payOf(p: Rec): NonNullable<NativeJob["pay"]> {
  const currency = str(rec(p.business_unit)?.currency)?.toUpperCase();
  const min = num(p.bounty_reward_min);
  const max = num(p.bounty_reward_max);
  if (p.bounty !== true || !max) {
    return {
      period: "unit",
      unit: "per valid report",
      text: p.gift === true ? "Gifts for valid reports, no cash bounty." : "No bounty: vulnerability disclosure program.",
    };
  }
  const range = min ? `${fmt(min)}–${fmt(max)}` : `up to ${fmt(max)}`;
  return {
    ...(min ? { min } : {}),
    max,
    ...(currency ? { currency } : {}),
    period: "unit",
    unit: "per valid report",
    text: `${range}${currency ? ` ${currency}` : ""} per valid report, by severity and asset value${p.gift === true ? ", plus gifts" : ""}`,
  };
}

function closed(p: Rec): string | undefined {
  if (p.archived === true) return "archived";
  if (p.disabled === true) return "disabled";
  return undefined;
}

function tagsOf(p: Rec): string[] {
  const type = str(p.type);
  const area = str(p.activity_area);
  const tags = [
    "bug-bounty",
    p.bounty === true ? "bounty" : "vdp",
    ...(type && type !== "bug-bounty" ? [slug(type)] : []),
    ...(p.gift === true ? ["gift"] : []),
    ...(str(p.hunter_audience) ? [`${slug(str(p.hunter_audience)!)}-hunters`] : []),
    ...(closed(p) ? [closed(p)!] : []),
    ...(area ? [slug(area)] : []),
  ];
  return [...tags.slice(0, 7), "source:yeswehack"];
}

function rawOf(p: Rec): Rec {
  return {
    type: str(p.type) ?? null,
    country: str(p.country) ?? null,
    activity_area: str(p.activity_area) ?? null,
    reports_count: num(p.reports_count) ?? null,
    scopes_count: num(p.scopes_count) ?? null,
    report_submission_cost: num(p.report_submission_cost) ?? null,
    hunter_audience: str(p.hunter_audience) ?? null,
    last_update_at: iso(p.last_update_at) ?? null,
  };
}

/** One program of GET /programs as a job. */
export function programToJob(p: Rec): NativeJob | null {
  const id = str(p.slug);
  const title = str(p.title);
  if (!id || !title || !SLUG.test(id)) return null;
  const unit = rec(p.business_unit);
  const about = str(unit?.description);
  const audience = str(p.hunter_audience);
  const isClosed = closed(p);
  return {
    id,
    kind: "task",
    title,
    ...(str(unit?.name) ? { org: str(unit?.name) } : {}),
    location: { remote: true },
    pay: payOf(p),
    ...(about ? { summary: stripHtml(about, 300) } : {}),
    url: `https://yeswehack.com/programs/${id}`,
    tags: tagsOf(p),
    ...(isClosed ? { stages: ["search" as const, "get" as const] } : {}),
    apply_hint: isClosed ? `This program is ${isClosed}; it takes no reports.` : APPLY_HINT,
    ...(audience ? { requirements: { rules: [`Open to ${audience} hunters only.`] } } : {}),
    raw: rawOf(p),
  };
}

type Scope = { scope: string; type: string | null; asset_value: string | null };

function scopesOf(p: Rec): Scope[] {
  const list = Array.isArray(p.scopes) ? (p.scopes as unknown[]) : [];
  const out: Scope[] = [];
  for (const item of list) {
    const s = rec(item);
    const scope = str(s?.scope);
    if (!s || !scope) continue;
    out.push({ scope, type: str(s.scope_type_name) ?? str(s.scope_type) ?? null, asset_value: str(s.asset_value) ?? null });
  }
  return out;
}

/** The reward grids by asset value, leaving out tiers with no amounts. */
function rewardGrid(p: Rec): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const tier of ASSET_TIERS) {
    const grid = rec(p[`reward_grid_${tier}`]);
    const row: Record<string, number> = {};
    for (const severity of SEVERITIES) {
      const amount = num(grid?.[`bounty_${severity}`]);
      if (amount !== undefined) row[severity] = amount;
    }
    if (Object.keys(row).length) out[tier] = row;
  }
  return out;
}

function scopeLine(s: Scope): string {
  const facts = [s.type, s.asset_value ? `asset value ${s.asset_value.toLowerCase()}` : ""].filter(Boolean).join(", ");
  return `${s.scope}${facts ? ` (${facts})` : ""}`;
}

const list = (label: string, items: string[]) => (items.length ? `${label}:\n- ${items.join("\n- ")}` : "");

/** GET /programs/{slug} as a job: the rules, the scopes, what qualifies and the reward grid. */
export function detailToJob(p: Rec): NativeJob | null {
  const base = programToJob(p);
  if (!base) return null;
  const scopes = scopesOf(p);
  const rules = stripHtml(str(p.rules) ?? str(p.rules_html), 3500);
  const access = stripHtml(str(p.account_access) ?? str(p.account_access_html), 800);
  const sections = [
    rules,
    list("Scopes", scopes.map(scopeLine)),
    list("Out of scope", strings(p.out_of_scope)),
    list("Qualifying vulnerabilities", strings(p.qualifying_vulnerability)),
    list("Non-qualifying vulnerabilities", strings(p.non_qualifying_vulnerability)),
    access ? `Account access:\n${access}` : "",
  ].filter(Boolean);
  const description = sections.length ? truncate(sections.join("\n\n"), 6000) : undefined;
  const ua = str(p.user_agent);
  const extra = [...(base.requirements?.rules ?? []), ...(ua ? [`Send the User-Agent ${ua}.`] : [])];
  const grid = rewardGrid(p);
  return {
    ...base,
    ...(description ? { description } : {}),
    ...(!base.summary && rules ? { summary: truncate(rules, 300) } : {}),
    ...(extra.length ? { requirements: { rules: extra } } : {}),
    raw: {
      ...rawOf(p),
      scopes,
      out_of_scope: strings(p.out_of_scope),
      ...(Object.keys(grid).length ? { reward_grid: grid } : {}),
    },
  };
}

const listCache = new WeakMap<typeof fetch, { at: number; rows: Rec[]; more: boolean }>();

/** Every public program (pages of 100), cached for ten minutes per fetch implementation. */
async function allPrograms(ctx: ConnectorContext): Promise<{ rows: Rec[]; more: boolean }> {
  const hit = listCache.get(ctx.fetch);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const rows: Rec[] = [];
  let more = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await fetchJson<{ items?: unknown[]; pagination?: Rec }>(
      ctx,
      `${YESWEHACK_API}/programs?page=${page}&resultsPerPage=100`,
      { label: `${LABEL} programs`, connector: ID },
    );
    if (!Array.isArray(body.items))
      throw new ProtocolError("upstream_error", "YesWeHack answered the program list in an unexpected shape.", { connector: ID });
    rows.push(...body.items.map(rec).filter((r): r is Rec => Boolean(r)));
    const pages = num(body.pagination?.nb_pages) ?? page;
    more = page < pages;
    if (!more || body.items.length === 0) break;
  }
  const out = { at: Date.now(), rows, more };
  listCache.set(ctx.fetch, out);
  return out;
}

export const yeswehack = defineConnector({
  id: ID,
  name: LABEL,
  description:
    "Public bug bounty and vulnerability disclosure programs on YesWeHack, with bounty ranges per valid report in EUR or USD, scopes, rules and reward grids. Find and read; reports are submitted on yeswehack.com.",
  homepage: "https://www.yeswehack.com",
  kinds: ["task"],
  category: "bounty",
  tier: "discover",
  payoutRails: ["fiat"],
  auth: { type: "none" },

  async search(query, ctx) {
    const limit = query.limit ?? 20;
    const { rows, more } = await allPrograms(ctx);
    const jobs = rows
      .map(programToJob)
      .filter((j): j is NativeJob => j !== null)
      .sort((a, b) => Number(Boolean(a.stages)) - Number(Boolean(b.stages)));
    const filtered = applyFilters(jobs, query, {});
    return { jobs: filtered.slice(0, limit), more: more || filtered.length > limit };
  },

  async get(nativeId, ctx) {
    if (!SLUG.test(nativeId)) return null;
    let body: unknown;
    try {
      body = await fetchJson<unknown>(ctx, `${YESWEHACK_API}/programs/${encodeURIComponent(nativeId)}`, {
        label: `${LABEL} program ${nativeId}`,
        connector: ID,
      });
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "auth_required")
        throw new ProtocolError("not_found", `YesWeHack program ${nativeId} is private: invited hunters see it on yeswehack.com.`, {
          connector: ID,
          cause: error,
        });
      throw error;
    }
    const row = rec(body);
    return row ? detailToJob(row) : null;
  },
});
