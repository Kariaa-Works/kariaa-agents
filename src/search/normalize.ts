/**
 * A published Job → an index row: pay in USD, skills, payout rails, a dedupe key and a content hash.
 */
import { createHash } from "node:crypto";
import { dedupeKey } from "../core/router.js";
import type { ConnectorCategory, Job, PayoutRail } from "../core/types.js";
import type { IndexRow } from "./types.js";

/** USD per unit. Stablecoins at par; the indexer refreshes fiat rates daily and falls back to these. */
export const FALLBACK_USD_RATES: Record<string, number> = {
  USD: 1,
  USDC: 1,
  USDT: 1,
  DAI: 1,
  PYUSD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.73,
  AUD: 0.66,
  NZD: 0.6,
  CHF: 1.13,
  JPY: 0.0067,
  INR: 0.012,
  SGD: 0.75,
  HKD: 0.13,
  SEK: 0.095,
  NOK: 0.094,
  DKK: 0.145,
  PLN: 0.25,
  BRL: 0.18,
  MXN: 0.055,
  ZAR: 0.055,
  NGN: 0.00065,
  KES: 0.0077,
  UAH: 0.024,
  PHP: 0.017,
};

/** Live rates from a keyless public endpoint, merged over the fallback. Never throws. */
export async function fetchUsdRates(fetchImpl: typeof fetch = fetch): Promise<Record<string, number>> {
  try {
    const res = await fetchImpl("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return FALLBACK_USD_RATES;
    const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (body.result !== "success" || !body.rates) return FALLBACK_USD_RATES;
    const rates: Record<string, number> = { ...FALLBACK_USD_RATES };
    for (const [code, perUsd] of Object.entries(body.rates)) {
      if (typeof perUsd === "number" && perUsd > 0) rates[code] = 1 / perUsd;
    }
    for (const stable of ["USDC", "USDT", "DAI", "PYUSD"]) rates[stable] = 1;
    return rates;
  } catch {
    return FALLBACK_USD_RATES;
  }
}

/** Skills people search by. Matched as whole words in the title, tags and text. */
const SKILLS: [string, RegExp][] = [
  ["python", /\bpython\b/iu],
  ["javascript", /\b(javascript|node\.?js|js)\b/iu],
  ["typescript", /\btypescript\b/iu],
  ["react", /\breact(\.js)?\b/iu],
  ["vue", /\bvue(\.js)?\b/iu],
  ["next.js", /\bnext\.?js\b/iu],
  ["rust", /\brust\b/iu],
  ["go", /\b(golang|go developer|go backend)\b/iu],
  ["java", /\bjava\b(?!script)/iu],
  ["kotlin", /\bkotlin\b/iu],
  ["swift", /\bswift\b/iu],
  ["c++", /\bc\+\+/iu],
  ["c#", /\bc#|\.net\b/iu],
  ["php", /\bphp\b/iu],
  ["ruby", /\bruby\b|\brails\b/iu],
  ["sql", /\bsql\b|\bpostgres(ql)?\b|\bmysql\b/iu],
  ["solidity", /\bsolidity\b/iu],
  ["smart contracts", /\bsmart contracts?\b/iu],
  ["web3", /\bweb3\b|\bblockchain\b|\bdefi\b/iu],
  ["machine learning", /\bmachine learning\b|\bml\b|\bdeep learning\b/iu],
  ["data science", /\bdata scien(ce|tist)\b|\bpandas\b|\bfeature engineering\b/iu],
  ["computer vision", /\bcomputer vision\b|\bimage (classification|segmentation)\b|\bobject detection\b/iu],
  ["nlp", /\bnlp\b|\bnatural language\b|\btext classification\b/iu],
  ["llm", /\bllms?\b|\blanguage models?\b|\bprompt(ing| engineering)?\b/iu],
  ["forecasting", /\bforecast(ing)?\b|\btime series\b|\bprediction\b/iu],
  ["security", /\bsecurity\b|\bvulnerabilit(y|ies)\b|\bpentest(ing)?\b|\bxss\b|\bcve\b/iu],
  ["devops", /\bdevops\b|\bkubernetes\b|\bdocker\b|\bterraform\b|\bci\/cd\b/iu],
  ["mobile", /\b(ios|android|mobile app|react native|flutter)\b/iu],
  ["frontend", /\bfront[- ]?end\b|\bcss\b|\bhtml\b/iu],
  ["backend", /\bback[- ]?end\b|\bapi\b/iu],
  ["design", /\bdesign(er)?\b|\bfigma\b|\bui\/ux\b|\bux\b/iu],
  ["writing", /\bwrit(ing|er)\b|\bcopywriting\b|\barticles?\b|\bblog\b/iu],
  ["translation", /\btranslat(e|ion|or)\b|\blocali[sz]ation\b/iu],
  ["video", /\bvideo\b|\bclips?\b|\bediting\b|\btiktok\b|\breels?\b|\bshorts\b/iu],
  ["photo", /\bphotos?\b|\bphotography\b|\bimages?\b/iu],
  ["audio", /\baudio\b|\bvoice\b|\brecordings?\b|\bspeech\b/iu],
  ["data labeling", /\blabell?ing\b|\bannotat(e|ion)\b|\btranscri(be|ption)\b/iu],
  ["research", /\bresearch\b|\banalysis\b|\breport\b/iu],
  ["marketing", /\bmarketing\b|\bseo\b|\bsocial media\b|\bugc\b/iu],
  ["documentation", /\bdocumentation\b|\bdocs\b|\btechnical writing\b/iu],
  ["testing", /\btesting\b|\bqa\b|\bunit tests?\b|\btest coverage\b/iu],
];

export function extractSkills(job: Job): string[] {
  const text = [job.title, (job.tags ?? []).join(" "), job.summary ?? "", (job.description ?? "").slice(0, 3000)].join(" \n ");
  return SKILLS.filter(([, re]) => re.test(text)).map(([skill]) => skill);
}

export function payUsd(job: Job, rates: Record<string, number>): number | undefined {
  const amount = job.pay?.max ?? job.pay?.min;
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return undefined;
  const code = (job.pay?.currency ?? "USD").trim().toUpperCase();
  const rate = rates[code];
  return rate ? Math.round(amount * rate * 100) / 100 : undefined;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/gu, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || undefined;
}

function iso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function toIndexRow(
  job: Job,
  source: { category?: ConnectorCategory; payoutRails?: readonly PayoutRail[] },
  rates: Record<string, number> = FALLBACK_USD_RATES,
): IndexRow {
  const rails = [...(source.payoutRails ?? [])];
  const usd = payUsd(job, rates);
  const description = clip(job.description, 8000);
  const summary = clip(job.summary, 600);
  const hash = createHash("sha256")
    .update(JSON.stringify([job.title, job.org, summary, description, job.pay, job.expires_at, job.stages, job.tags]))
    .digest("hex");
  const titleKey = `${(job.org ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "")}|${job.title.toLowerCase().replace(/[^a-z0-9]+/gu, "")}`;
  const row: IndexRow = {
    id: job.id,
    connector_id: job.connector,
    kind: job.kind,
    title: job.title.slice(0, 300),
    skills: extractSkills(job),
    tags: (job.tags ?? []).slice(0, 30),
    payout_rails: rails,
    fiat: rails.includes("fiat"),
    stages: [...job.stages],
    job,
    content_hash: hash,
    dedupe_key: job.url ? dedupeKey(job) : titleKey,
  };
  if (source.category) row.category = source.category;
  if (job.org) row.org = job.org.slice(0, 200);
  if (summary) row.summary = summary;
  if (description) row.description = description;
  if (job.location?.text) row.location_text = job.location.text.slice(0, 200);
  if (job.location?.remote !== undefined) row.remote = job.location.remote;
  if (job.pay?.min !== undefined) row.pay_min = job.pay.min;
  if (job.pay?.max !== undefined) row.pay_max = job.pay.max;
  if (job.pay?.currency) row.currency = job.pay.currency.toUpperCase();
  if (job.pay?.period) row.pay_period = job.pay.period;
  if (usd !== undefined) row.pay_usd = usd;
  if (job.participation_mode) row.participation_mode = job.participation_mode;
  if (job.url) row.url = job.url;
  const posted = iso(job.posted_at);
  if (posted) row.posted_at = posted;
  const expires = iso(job.expires_at);
  if (expires) row.expires_at = expires;
  return row;
}

/** The text an embedding is made from: the parts that say what the work is. */
export function embeddingText(row: IndexRow): string {
  return [row.title, row.org, row.skills.join(", "), row.tags.join(", "), row.summary, row.description?.slice(0, 1500)]
    .filter(Boolean)
    .join("\n");
}
