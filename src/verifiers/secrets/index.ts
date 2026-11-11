/**
 * Nothing an agent sends should carry a key. An agent that pastes its environment, a config file or
 * a log into an answer hands its owner's credentials to a stranger; this stops that before it leaves.
 */
import { defineVerifier, type Check } from "../../core/verifier.js";

/** What a key or token looks like. Shapes only: nothing is checked against a service. */
const SHAPES: Array<[RegExp, string]> = [
  [/\bkra_[A-Za-z0-9_-]{16,}/u, "a Kariaa key"],
  [/\bsk[-_](?:live_|test_|ant-|proj-)?[A-Za-z0-9_-]{20,}/u, "an API key (sk-…)"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/u, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/u, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/u, "an AWS key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/u, "a Google API key"],
  [/\bxox[abpsr]-[A-Za-z0-9-]{20,}/u, "a Slack token"],
  [/\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/u, "a signed token (JWT)"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, "a private key"],
];

const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|x-sh|javascript|typescript)\b)/u;
/** Files larger than this are not read as text. */
const MAX_BYTES = 2 * 1024 * 1024;

export function secretsIn(text: string): string[] {
  return [...new Set(SHAPES.filter(([shape]) => shape.test(text)).map(([, what]) => what))];
}

export const secrets = defineVerifier({
  id: "secrets",
  name: "No keys in the work",
  description:
    "A written answer or a text file does not contain anything shaped like a key, a token or a private key. Media and large files are not read.",
  deterministic: true,
  verify({ work }) {
    const checks: Check[] = [];
    let accepted = 0;
    work.forEach((piece, index) => {
      const label = piece.kind === "file" ? piece.name : `text ${index + 1}`;
      let body: string | undefined;
      if (piece.kind === "text") body = piece.text;
      else if (TEXT_TYPES.test(piece.mime_type) && piece.bytes.byteLength <= MAX_BYTES) body = new TextDecoder().decode(piece.bytes);
      const found = body === undefined ? [] : secretsIn(body);
      if (found.length) {
        // The message names the kind of key, never the key.
        checks.push({
          id: "no_secret",
          ok: false,
          file: label,
          message: `${label} contains ${found.join(" and ")}; remove it before sending`,
        });
        return;
      }
      if (body !== undefined) checks.push({ id: "no_secret", ok: true, file: label, message: `${label} carries no key or token` });
      accepted += 1;
    });
    return { verifier: "secrets", outcome: checks.some((c) => !c.ok) ? "fail" : "pass", checks, accepted_units: accepted };
  },
});
