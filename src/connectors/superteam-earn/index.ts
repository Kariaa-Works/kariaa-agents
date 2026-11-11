/**
 * Superteam Earn: bounties, projects and hackathons in the Solana ecosystem,
 * paid in USDC and other tokens. The public listings API finds and reads
 * without a key; the official agent API (https://superteam.fun/skill.md)
 * registers an agent, adds the agent-only listings, and submits work. A person
 * claims the agent with its claim code before any payout.
 */
import { randomBytes } from "node:crypto";
import { defineConnector, type ConnectorContext } from "../../core/connector.js";
import { ProtocolError } from "../../core/errors.js";
import { fetchJson } from "../../core/http.js";
import { applyFilters, iso, num, str, strings } from "../../core/jsonBoard.js";
import { stripHtml } from "../../core/text.js";
import type { NativeApplication, NativeJob, Question } from "../../core/types.js";

export const SUPERTEAM_API = "https://superteam.fun/api";
const ID = "superteam-earn";
const LABEL = "Superteam Earn";
const KEY_ENV = "SUPERTEAM_AGENT_KEY";
const CLAIM_ENV = "SUPERTEAM_CLAIM_CODE";
export const SUPERTEAM_HELP =
  "Connect with connect_account to register an agent on Superteam Earn (no form), or set SUPERTEAM_AGENT_KEY to an agent key (sk_…) from POST https://superteam.fun/api/agents. Finding and reading work without it.";

const claimUrl = (code: string) => `https://superteam.fun/earn/claim/${encodeURIComponent(code)}`;
const claimStep = (code: string | undefined) =>
  code
    ? `A person claims the agent at ${claimUrl(code)} (signed in, talent profile complete) before Superteam Earn pays any reward.`
    : "A person claims the agent with its claim code before Superteam Earn pays any reward.";

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);

/** One listing (list row or detail) as a job. Bounties are tasks; projects (apply with a proposal) are listings. */
export function listingToJob(l: Rec): NativeJob | null {
  const slug = str(l.slug);
  const title = str(l.title);
  if (!slug || !title) return null;
  const sponsor = rec(l.sponsor);
  const token = str(l.token) ?? "USDC";
  const type = str(l.type) ?? "bounty";
  const compensation = str(l.compensationType) ?? "fixed";
  const amount = num(l.rewardAmount);
  const minAsk = num(l.minRewardAsk);
  const maxAsk = num(l.maxRewardAsk);
  const unit = type === "project" ? "per project" : "prize pool, split among the winners";
  const pay =
    compensation === "range" && (minAsk !== undefined || maxAsk !== undefined)
      ? {
          ...(minAsk !== undefined ? { min: minAsk } : {}),
          ...(maxAsk !== undefined ? { max: maxAsk } : {}),
          currency: token,
          period: "unit" as const,
          unit,
          text: `${minAsk ?? "?"}–${maxAsk ?? "?"} ${token}`,
        }
      : compensation === "variable"
        ? { currency: token, period: "unit" as const, unit, text: `variable, paid in ${token}` }
        : amount !== undefined
          ? { min: amount, max: amount, currency: token, period: "unit" as const, unit, text: `${amount.toLocaleString("en-US")} ${token}` }
          : undefined;
  const access = str(l.agentAccess);
  const status = str(l.status);
  const description = str(l.description);
  const skills = Array.isArray(l.skills)
    ? (l.skills as unknown[]).flatMap((s) => [str(rec(s)?.skills), ...strings(rec(s)?.subskills)]).filter((s): s is string => Boolean(s))
    : [];
  const asked = eligibilityOf(l);
  const questions = asked.map((q) => q.question);
  const body = description ? stripHtml(description, 6000) : undefined;
  const region = str(l.region);
  const posted = iso(l.publishedAt);
  const deadline = iso(l.deadline);
  return {
    id: slug,
    kind: type === "project" ? "listing" : "task",
    title,
    ...(str(sponsor?.name) ? { org: str(sponsor?.name) } : {}),
    ...(pay ? { pay } : {}),
    ...(body
      ? {
          summary: stripHtml(description, 300),
          description: questions.length ? `${body}\n\nThe submission asks for:\n- ${questions.join("\n- ")}` : body,
        }
      : {}),
    location: { remote: true, ...(region && region.toLowerCase() !== "global" ? { text: region } : {}) },
    url: `https://superteam.fun/earn/listing/${slug}`,
    ...(posted ? { posted_at: posted } : {}),
    ...(deadline ? { expires_at: deadline } : {}),
    tags: [
      type,
      ...(access ? [access.toLowerCase().replace(/_/gu, "-")] : []),
      ...skills.slice(0, 8),
      ...(l.isFeatured === true ? ["featured"] : []),
      "source:superteam",
    ],
    ...(asked.length ? { requirements: { questions: asked } } : {}),
    ...(status && status !== "OPEN" ? { stages: ["search", "get"] } : access === "HUMAN_ONLY" ? { stages: ["search", "get"] } : {}),
    apply_hint:
      access === "HUMAN_ONLY"
        ? "Marked human only: a person submits on the listing page with a Superteam Earn account."
        : `Submit with apply_to_job: answers.link (the work), note (what you built and how it works), one answer per question id${
            compensation === "fixed" ? "" : ", answers.ask (your quote)"
          }${type === "project" ? ", answers.telegram (the operator's t.me/<username> link, required for projects)" : ""}.`,
  };
}

/** Eligibility questions as `q1`, `q2`… in the listing's order. */
function eligibilityOf(l: Rec): Question[] {
  const rows = Array.isArray(l.eligibility) ? (l.eligibility as unknown[]).map(rec).filter((q): q is Rec => Boolean(q)) : [];
  return rows
    .sort((a, b) => (num(a.order) ?? 0) - (num(b.order) ?? 0))
    .flatMap((q, i) => {
      const question = str(q.question);
      return question ? [{ id: `q${i + 1}`, question, type: "text" as const, required: q.optional !== true }] : [];
    });
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(", ") : value)?.trim() || undefined;

async function agentApi<T>(ctx: ConnectorContext, key: string, target: string, body?: unknown): Promise<T> {
  return fetchJson<T>(ctx, `${SUPERTEAM_API}/agents${target}`, {
    label: LABEL,
    connector: ID,
    headers: { authorization: `Bearer ${key}` },
    ...(body === undefined ? {} : { method: "POST" as const, body }),
    authHelp: SUPERTEAM_HELP,
  });
}

/** The agent details answer agent-eligible listings only; any other listing comes from the public details. */
async function listing(ctx: ConnectorContext, slug: string): Promise<Rec | undefined> {
  const key = ctx.credentials[KEY_ENV];
  if (key) {
    try {
      return rec(await agentApi<unknown>(ctx, key, `/listings/details/${slug}`));
    } catch (error) {
      if (!(error instanceof ProtocolError) || (error.code !== "not_found" && error.code !== "auth_required")) throw error;
    }
  }
  return rec(await fetchJson<unknown>(ctx, `${SUPERTEAM_API}/listings/details/${slug}`, { label: LABEL, connector: ID }));
}

function requireKey(ctx: ConnectorContext): string {
  const key = ctx.credentials[KEY_ENV];
  if (!key) throw new ProtocolError("auth_required", SUPERTEAM_HELP, { connector: ID });
  return key;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/u;

export const superteamEarn = defineConnector({
  id: ID,
  name: LABEL,
  description:
    "Bounties, projects and hackathons in the Solana ecosystem from Superteam Earn, paid in USDC and other tokens. Find and read without a key; with an agent key (connect_account registers one), see the agent-only listings and submit work. A person claims the agent before payouts.",
  homepage: "https://superteam.fun/earn",
  kinds: ["task", "listing"],
  category: "bounty",
  payoutRails: ["crypto"],
  tier: "managed",
  auth: { type: "api_key", env: [KEY_ENV, CLAIM_ENV], help: SUPERTEAM_HELP, required: false },

  /** The public feed, plus the agent feed (agent-only listings) when there is a key; one row per slug. */
  async search(query, ctx) {
    const key = ctx.credentials[KEY_ENV];
    const asRows = (body: unknown) =>
      Array.isArray(body) ? body : Array.isArray(rec(body)?.listings) ? (rec(body)!.listings as unknown[]) : [];
    const [open, agent] = await Promise.all([
      fetchJson<unknown>(ctx, `${SUPERTEAM_API}/listings?take=100`, { label: LABEL, connector: ID }),
      key ? agentApi<unknown>(ctx, key, "/listings/live?take=100") : Promise.resolve([]),
    ]);
    const seen = new Set<string>();
    const rows = [...asRows(agent), ...asRows(open)].filter((row) => {
      const slug = str(rec(row)?.slug);
      if (!slug || seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
    const jobs = rows
      .map(rec)
      .map((row) => (row ? listingToJob(row) : null))
      .filter((j): j is NativeJob => j !== null);
    const filtered = applyFilters(jobs, query, {});
    const limit = query.limit ?? 20;
    return { jobs: filtered.slice(0, limit), more: filtered.length > limit };
  },

  async get(nativeId, ctx) {
    if (!SLUG.test(nativeId)) return null;
    const row = await listing(ctx, nativeId);
    return row ? listingToJob(row) : null;
  },

  /** Submits the work in one call: the link, what was built, the answers. A second call edits the submission. */
  async apply(nativeId, input, ctx) {
    const key = requireKey(ctx);
    if (!SLUG.test(nativeId)) throw new ProtocolError("not_found", `${JSON.stringify(nativeId)} is not a Superteam Earn listing slug.`);
    const l = await listing(ctx, nativeId);
    const listingId = str(l?.id);
    if (!l || !listingId) throw new ProtocolError("not_found", `No Superteam Earn listing ${nativeId}.`, { connector: ID });
    if (str(l.agentAccess) === "HUMAN_ONLY")
      throw new ProtocolError("forbidden", "This listing is human only: agents can't submit to it.", { connector: ID });
    const answers = input.answers ?? {};
    const link = one(answers.link);
    const note = input.note?.trim();
    if (!link && !note)
      throw new ProtocolError("invalid_input", "Superteam Earn needs answers.link (the work) or a note describing it.", { connector: ID });
    const asked = eligibilityOf(l);
    const missing = asked.filter((q) => q.required && !one(answers[q.id]));
    if (missing.length)
      throw new ProtocolError("invalid_input", `Answer ${missing.map((q) => `${q.id} (${q.question})`).join("; ")}.`, { connector: ID });
    const type = str(l.type) ?? "bounty";
    const telegram = one(answers.telegram);
    if (type === "project" && !telegram)
      throw new ProtocolError("invalid_input", "Projects need answers.telegram: the operator's t.me/<username> link.", { connector: ID });
    const askText = one(answers.ask) ?? input.preferred_rate;
    const ask = askText === undefined ? null : Number(askText.replace(/[^\d.]/gu, ""));
    if (str(l.compensationType) && str(l.compensationType) !== "fixed" && !(ask && ask > 0))
      throw new ProtocolError("invalid_input", "This listing takes a quote: answers.ask, your price in the listing's token.", {
        connector: ID,
      });
    const payload = {
      listingId,
      link: link ?? "",
      tweet: one(answers.tweet) ?? "",
      otherInfo: note ?? "",
      eligibilityAnswers: asked.map((q) => ({ question: q.question, answer: one(answers[q.id]) ?? "" })),
      ask: ask && ask > 0 ? ask : null,
      ...(telegram ? { telegram: telegram.startsWith("http") ? telegram : `http://${telegram.replace(/^\/+/u, "")}` } : {}),
    };
    let edited = false;
    try {
      await agentApi<unknown>(ctx, key, "/submissions/create", payload);
    } catch (error) {
      if (!(error instanceof ProtocolError) || !/already|exists|duplicate/iu.test(error.message)) throw error;
      await agentApi<unknown>(ctx, key, "/submissions/update", payload);
      edited = true;
    }
    return submission(nativeId, l, edited ? "Submission updated." : "Submitted.", ctx.credentials[CLAIM_ENV]);
  },

  async status(nativeApplicationId, ctx) {
    requireKey(ctx);
    if (!SLUG.test(nativeApplicationId)) return null;
    const l = await listing(ctx, nativeApplicationId);
    return l ? submission(nativeApplicationId, l, undefined, ctx.credentials[CLAIM_ENV]) : null;
  },

  async register(input, ctx) {
    // The name is public on the agent's profile: never built from the email, and made unique with a suffix.
    const base = (input.handle ?? input.name ?? "Kariaa agent").trim().slice(0, 32) || "Kariaa agent";
    const name = `${base}-${randomBytes(3).toString("hex")}`;
    const body = rec(
      await fetchJson<unknown>(ctx, `${SUPERTEAM_API}/agents`, {
        label: `${LABEL} sign-up`,
        connector: ID,
        method: "POST",
        body: { name },
      }),
    );
    const key = str(body?.apiKey);
    if (!key) throw new ProtocolError("upstream_error", `${LABEL} registered the agent but sent no key.`, { connector: ID });
    const code = str(body?.claimCode);
    return {
      credentials: { [KEY_ENV]: key, ...(code ? { [CLAIM_ENV]: code } : {}) },
      account_id: str(body?.username) ?? str(body?.agentId) ?? name,
      next_step: claimStep(code),
    };
  },

  async account(ctx) {
    const key = ctx.credentials[KEY_ENV];
    if (!key) return { signed_in: false, help: SUPERTEAM_HELP };
    await agentApi<unknown>(ctx, key, "/listings/live?take=1");
    const code = ctx.credentials[CLAIM_ENV];
    return {
      signed_in: true,
      label: "Superteam Earn agent",
      ready: true,
      ...(code ? { profile: { claim_url: claimUrl(code) } } : {}),
      help: claimStep(code),
    };
  },
});

/** Superteam's agent API answers a submission with no state of its own: the listing tells where judging stands. */
function submission(slug: string, l: Rec, done: string | undefined, claimCode: string | undefined): NativeApplication {
  const announced = l.isWinnersAnnounced === true;
  const open = (str(l.status) ?? "OPEN") === "OPEN" && !announced;
  const deadline = iso(l.deadline);
  return {
    id: slug,
    job_id: slug,
    ...(str(l.title) ? { job_title: str(l.title) } : {}),
    stage: announced ? "closed" : "in_review",
    next: [
      done,
      announced
        ? "Winners are announced on the listing page."
        : open
          ? `Judging starts after the deadline${deadline ? ` (${deadline.slice(0, 10)})` : ""}; the submission can be edited until then.`
          : "Submissions are closed; winners are announced on the listing page.",
      claimStep(claimCode),
    ]
      .filter(Boolean)
      .join(" "),
    url: `https://superteam.fun/earn/listing/${slug}`,
  };
}
