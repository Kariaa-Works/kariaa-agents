/**
 * A verifier judges work against a task's requirements and says pass, fail or
 * uncertain, with one check per thing it looked at.
 *
 * Copy this folder to `src/verifiers/<id>/`, fill in the TODOs, add the import
 * to `src/verifiers/index.ts`, and keep it deterministic: same input, same
 * verdict, no network, no randomness. Anything you cannot decide from the
 * bytes and the requirements is `uncertain`, never a guess.
 */
import { defineVerifier, type Check } from "../../core/verifier.js";

export const exampleVerifier = defineVerifier({
  // TODO: lowercase letters, digits and dashes.
  id: "example-verifier",
  name: "Example verifier",
  description: "What it checks, in one sentence, and what makes it answer uncertain.",
  // TODO: which tasks it can judge; delete `applies` for any task.
  applies: { media: ["audio"] },
  deterministic: true,
  verify({ job, work }) {
    const checks: Check[] = [];
    let accepted = 0;
    for (const piece of work) {
      if (piece.kind !== "file") continue;
      // TODO: look at piece.bytes, piece.mime_type, piece.name and job.requirements.
      const ok = piece.bytes.byteLength > 0;
      checks.push({ id: "not_empty", ok, file: piece.name, message: ok ? `${piece.name} has content` : `${piece.name} is empty` });
      if (ok) accepted += 1;
    }
    return { verifier: "example-verifier", outcome: checks.some((c) => !c.ok) ? "fail" : "pass", checks, accepted_units: accepted };
  },
});
