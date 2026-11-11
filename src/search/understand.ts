/**
 * Turns a person's or agent's words into filters plus the words left to match:
 * "python bounty over $200 paid in USD, remote" → category bounty, min $200, fiat only, remote, "python".
 * Deterministic and offline; semantic matching is the embedding's job.
 */
import type { ConnectorCategory } from "../core/types.js";

export type Understood = {
  /** The words to match, with synonyms added for full-text search. */
  text: string;
  /** The words to match as the person wrote them, without the filters or synonyms. For sources searched live. */
  core: string;
  categories?: ConnectorCategory[];
  minPayUsd?: number;
  fiatOnly?: boolean;
  cryptoOnly?: boolean;
  remoteOnly?: boolean;
  /** Asked for work an agent can do on its own. */
  forAgents?: boolean;
  /** "today", "this week", "this month": the earliest posting date wanted (YYYY-MM-DD, UTC). */
  postedAfter?: string;
};

const CATEGORY_WORDS: [RegExp, ConnectorCategory][] = [
  [/\b(bug )?bount(y|ies)\b/giu, "bounty"],
  [/\b(competitions?|contests?|challenges?|leaderboards?|hackathons?)\b/giu, "competition"],
  [/\b(micro[- ]?tasks?|labell?ing|annotation|data (collection|samples?)|clipping|clips?|ugc)\b/giu, "micro_task"],
  [/\b(sell(ing)?|listings? to sell|my (store|shop)|products? to list)\b/giu, "selling"],
  [/\b(freelance|gigs?|contract (work|roles?))\b/giu, "job"],
];

const FIAT =
  /\b(paid in|pays? in|payout in|in)\s+(usd|eur|gbp|fiat|cash|dollars?|euros?|bank|paypal)\b|\b(no crypto|fiat only|non[- ]crypto)\b/giu;
const CRYPTO = /\b(paid in|pays? in|in)\s+(crypto|usdc|usdt|eth|sol|near|tokens?)\b|\bcrypto only\b/giu;
const REMOTE = /\b(fully )?remote( only)?\b|\banywhere\b|\bwork from home\b/giu;
const AGENTS = /\b(for (ai )?agents?|agent[- ](doable|friendly|tasks?|work)|an agent can do|autonomous(ly)?)\b/giu;
const TODAY = /\b(posted |new )?today\b/giu;
const THIS_WEEK = /\b(posted |new )?(this|past|last) week\b/giu;
const THIS_MONTH = /\b(posted |new )?this month\b/giu;
const PAY =
  /(?:\b(?:over|above|more than|at least|min(?:imum)?|from|>=?)\s*)?(?:\$|usd\s*)\s?(\d+(?:[.,]\d+)?)\s*(k)?\s*(\+|or more|and up)?(?=\s|$|[,.;)])|\b(?:over|above|more than|at least|min(?:imum)?)\s+(\d+(?:[.,]\d+)?)\s*(k)?\s*(?:usd|dollars?)\b/giu;

/** A few spellings people use for the same skill, added so full-text search finds either. */
const SYNONYMS: Record<string, string> = {
  ml: "machine learning",
  ai: "artificial intelligence machine learning",
  llm: "language model ai",
  js: "javascript",
  ts: "typescript",
  py: "python",
  golang: "go",
  k8s: "kubernetes",
  ux: "user experience design",
  ui: "user interface design",
  nlp: "natural language processing",
  cv: "computer vision",
  web3: "blockchain smart contract",
  solidity: "smart contract ethereum",
  pentest: "penetration testing security",
  appsec: "application security",
  "video editing": "video editor clips",
};

function amount(raw: string, k?: string): number {
  const n = Number(raw.replace(",", "."));
  return k ? n * 1000 : n;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function understand(input: string | undefined, now = Date.now()): Understood {
  let text = ` ${(input ?? "").trim()} `;
  const out: Understood = { text: "", core: "" };

  const take = (re: RegExp, on: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) on(m);
    text = text.replace(re, " ");
  };

  take(PAY, (m) => {
    const value = m[1] !== undefined ? amount(m[1], m[2]) : amount(m[4]!, m[5]);
    if (Number.isFinite(value) && value > 0) out.minPayUsd = Math.max(out.minPayUsd ?? 0, value);
  });
  take(FIAT, () => (out.fiatOnly = true));
  take(CRYPTO, () => (out.cryptoOnly = true));
  take(REMOTE, () => (out.remoteOnly = true));
  take(AGENTS, () => (out.forAgents = true));
  // The narrowest wins: "this month, posted today" is today.
  take(THIS_MONTH, () => (out.postedAfter = day(now).slice(0, 8) + "01"));
  take(THIS_WEEK, () => (out.postedAfter = day(now - 7 * 86_400_000)));
  take(TODAY, () => (out.postedAfter = day(now)));
  const categories = new Set<ConnectorCategory>();
  for (const [re, category] of CATEGORY_WORDS) take(re, () => categories.add(category));
  if (categories.size) out.categories = [...categories];

  const words = text
    .replace(/[,;]+/gu, " ")
    .replace(/\b(paid|pays|that|which|with|and|or|the|a|an|for|to|of|jobs?|work|tasks?|find|me|some|any|i|want|looking|need)\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const lower = words.toLowerCase();
  const extra = Object.entries(SYNONYMS)
    .filter(([term]) => new RegExp(`(^|\\s)${term.replace(/\s+/gu, "\\s+")}(\\s|$)`, "iu").test(lower))
    .map(([, expansion]) => expansion);
  out.core = words;
  out.text = [words, ...extra].filter(Boolean).join(" ");
  if (out.fiatOnly && out.cryptoOnly) delete out.cryptoOnly;
  return out;
}
