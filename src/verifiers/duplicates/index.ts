import { createHash } from "node:crypto";
import { defineVerifier, type Check } from "../../core/verifier.js";
import type { ResolvedWork } from "../../core/types.js";

export function fingerprint(piece: ResolvedWork): string {
  const hash = createHash("sha256");
  if (piece.kind === "text") hash.update(piece.text.trim().replace(/\s+/gu, " ").toLowerCase());
  else hash.update(piece.bytes);
  return hash.digest("hex");
}

/** No piece appears twice in the batch, and none was accepted before. */
export const duplicates = defineVerifier({
  id: "duplicates",
  name: "Duplicates",
  description:
    "Every piece is new: not the same bytes or text as another piece in the batch, and not among the fingerprints the platform already accepted.",
  deterministic: true,
  verify({ work }, ctx) {
    const checks: Check[] = [];
    const seen = new Map<string, string>();
    let accepted = 0;
    work.forEach((piece, index) => {
      const label = piece.kind === "file" ? piece.name : `text ${index + 1}`;
      const print = fingerprint(piece);
      const earlier = seen.get(print);
      if (earlier) {
        checks.push({
          id: "duplicate",
          ok: false,
          file: label,
          message: `${label} is the same as ${earlier}`,
          details: { duplicate_of: earlier },
        });
        return;
      }
      seen.set(print, label);
      if (ctx.known_fingerprints?.has(print)) {
        checks.push({
          id: "resubmitted",
          ok: false,
          file: label,
          message: `${label} was already accepted before`,
          details: { fingerprint: print },
        });
        return;
      }
      checks.push({ id: "unique", ok: true, file: label, message: `${label} is new`, details: { fingerprint: print } });
      accepted += 1;
    });
    return { verifier: "duplicates", outcome: checks.some((c) => !c.ok) ? "fail" : "pass", checks, accepted_units: accepted };
  },
});
