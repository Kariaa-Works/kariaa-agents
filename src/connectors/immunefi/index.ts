/**
 * Immunefi (immunefi.com): bug bounty programs for blockchain projects, paid in stablecoins and
 * project tokens for a valid vulnerability report. The public list is one JSON file with every
 * program; this connector finds and reads programs. Reports are submitted on immunefi.com.
 */
import { defineJsonBoard, iso, num, str, strings } from "../../core/jsonBoard.js";
import { truncate } from "../../core/text.js";

type Row = Record<string, unknown>;

export const IMMUNEFI_BOUNTIES = "https://immunefi.com/public-api/bounties.json";

export const immunefi = defineJsonBoard({
  id: "immunefi",
  name: "Immunefi",
  description:
    "Bug bounty programs for blockchain projects on Immunefi, with the largest reward per valid report and the token it is paid in. Find and read; reports are submitted on immunefi.com.",
  homepage: "https://immunefi.com",
  kinds: ["task"],
  category: "bounty",
  payoutRails: ["crypto"],
  // The file is large and ignores the query: keep it for ten minutes.
  cacheTtlMs: 10 * 60_000,

  // One public file holds every program; the query and the limit are applied to its rows here.
  request: () => new URL(IMMUNEFI_BOUNTIES),

  rows: (body) => (Array.isArray(body) ? body : []),

  map: (row) => {
    const r = row as Row;
    const slug = str(r.slug);
    const project = str(r.project);
    // Invite-only and paused programs are not open to a new researcher.
    if (!slug || !project || r.inviteOnly === true || r.isPaused === true) return null;
    const max = num(r.maxBounty);
    const token = str(r.rewardsToken);
    const description = str(r.description);
    return {
      id: slug,
      kind: "task",
      title: `${project} bug bounty`,
      org: project,
      location: { remote: true },
      ...(max
        ? {
            pay: {
              max,
              currency: "USD",
              period: "unit",
              unit: "per valid report",
              text: `Up to USD ${max.toLocaleString("en-US")} per valid report${token ? `, paid in ${token}` : ""}`,
            },
          }
        : {}),
      ...(description ? { summary: truncate(description, 300), description } : {}),
      url: `https://immunefi.com/bug-bounty/${slug}/`,
      apply_hint: `Read the scope and rules at https://immunefi.com/bug-bounty/${slug}/ and submit the report there${r.kyc === true ? "; this program asks for identity checks before paying" : ""}.`,
      ...(iso(r.launchDate) ? { posted_at: iso(r.launchDate) } : {}),
      tags: [...strings(r.productType), ...strings(r.ecosystem), ...strings(r.language), "bug-bounty", "source:immunefi"],
    };
  },

  applies: {},
});
