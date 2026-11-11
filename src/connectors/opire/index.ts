/**
 * Opire (opire.dev): cash rewards on GitHub issues. A maintainer or anyone else puts money on an
 * issue; whoever's pull request closes it claims the reward, paid in USD through Stripe. The public
 * API lists every open reward. This connector finds and reads them; the work happens on GitHub.
 */
import { defineJsonBoard, iso, num, str, strings } from "../../core/jsonBoard.js";

type Row = Record<string, unknown>;
const rec = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

export const OPIRE_REWARDS = "https://api.opire.dev/rewards";

export const opire = defineJsonBoard({
  id: "opire",
  name: "Opire",
  description:
    "Cash rewards on GitHub issues from Opire, paid in USD through Stripe to whoever's pull request closes the issue. Find and read; the fix and the claim are made on GitHub.",
  homepage: "https://opire.dev",
  kinds: ["task"],
  category: "bounty",
  payoutRails: ["fiat"],

  // The API returns every open reward and takes no query; the query is applied to the rows here.
  request: () => new URL(OPIRE_REWARDS),

  rows: (body) => (Array.isArray(body) ? body : []),

  map: (row) => {
    const r = row as Row;
    const id = str(r.id);
    const title = str(r.title);
    const url = str(r.url);
    if (!id || !title || !url) return null;
    const price = rec(r.pendingPrice);
    const cents = price.unit === "USD_CENT" ? num(price.value) : undefined;
    const project = str(rec(r.project).name);
    const org = str(rec(r.organization).name);
    const created = num(r.createdAt);
    return {
      id,
      kind: "task",
      title,
      ...(org ? { org } : {}),
      location: { remote: true },
      ...(cents ? { pay: { min: cents / 100, max: cents / 100, currency: "USD", text: `USD ${cents / 100} for the fix` } } : {}),
      summary: `A reward on a GitHub issue${project ? ` in ${project}` : ""}.`,
      url,
      apply_hint: `Read the issue at ${url}. Comment /try to say you are working on it, open a pull request that closes it, then comment /claim #<issue> in the pull request.`,
      ...(created && iso(new Date(created).toISOString()) ? { posted_at: new Date(created).toISOString() } : {}),
      tags: [...strings(r.programmingLanguages), ...(project ? [project] : []), "open-source", "source:opire"],
    };
  },

  applies: {},
});
