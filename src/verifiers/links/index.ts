/**
 * Much paid work is delivered as a link: a pull request, a document, a deployed page. A link the
 * reviewer cannot open is a delivery that did not happen. This reads the links in a written answer
 * and fails the ones nobody else could reach: placeholders, a machine's own address, a file path.
 * It never opens a link, so it cannot say whether a public link still works.
 */
import { defineVerifier, type Check } from "../../core/verifier.js";

const LINK = /\b(?:https?|file|ftp):\/\/[^\s<>"'`)\]]+/giu;
const PLACEHOLDER_HOSTS = /(?:^|\.)(?:example\.(?:com|org|net)|test|invalid|localhost|local|internal)$/iu;
const PLACEHOLDER_PARTS = /(?:your-?(?:repo|name|user|link|domain)|<[^>]+>|\{[^}]+\}|\bTODO\b|xxx+)/iu;

/** Why nobody else could open this link, or undefined when it looks reachable. */
export function unreachable(link: string): string | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return "is not a valid link";
  }
  if (url.protocol === "file:") return "is a file on your machine";
  if (url.protocol !== "https:") return "is not https";
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (PLACEHOLDER_HOSTS.test(host)) return "is a placeholder or a local address";
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(host)) return "points at a private address";
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/iu.test(host) || /^fe80:/iu.test(host)) return "points at a private address";
  if (!host.includes(".") && !host.includes(":")) return "has no public host name";
  if (PLACEHOLDER_PARTS.test(decodeURIComponent(url.pathname + url.search))) return "still has a placeholder in it";
  return undefined;
}

export const links = defineVerifier({
  id: "links",
  name: "Links a reviewer can open",
  description:
    "Every link in a written answer is a public https link, not a placeholder, a local address or a file path. Links are read, never opened.",
  applies: { media: ["text"] },
  deterministic: true,
  verify({ work }) {
    const checks: Check[] = [];
    let accepted = 0;
    work.forEach((piece, index) => {
      if (piece.kind !== "text") {
        accepted += 1;
        return;
      }
      const label = `text ${index + 1}`;
      const found = [...new Set((piece.text.match(LINK) ?? []).map((link) => link.replace(/[.,;:!?]+$/u, "")))];
      const bad = found.map((link) => ({ link, why: unreachable(link) })).filter((entry) => entry.why);
      for (const { link, why } of bad) checks.push({ id: "link", ok: false, file: label, message: `${label}: ${link} ${why}` });
      if (found.length && !bad.length)
        checks.push({
          id: "link",
          ok: true,
          file: label,
          message: `${label}: ${found.length} link${found.length === 1 ? "" : "s"} a reviewer can open`,
        });
      if (!bad.length) accepted += 1;
    });
    return { verifier: "links", outcome: checks.some((c) => !c.ok) ? "fail" : "pass", checks, accepted_units: accepted };
  },
});
