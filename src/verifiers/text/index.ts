import { defineVerifier, type Check } from "../../core/verifier.js";

const MIN_WORDS = 3;
const MAX_RUN = 8;
const MIN_DISTINCT_RATIO = 0.12;

function words(text: string): string[] {
  return text.split(/\s+/u).filter((w) => /\p{L}|\p{N}/u.test(w));
}

function longestRun(text: string): number {
  let best = 0;
  let run = 0;
  let last = "";
  for (const ch of text) {
    run = ch === last ? run + 1 : 1;
    last = ch;
    if (run > best) best = run;
  }
  return best;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Written answers read like answers: enough words, not keyboard mashing, not the task's own material pasted back. */
export const text = defineVerifier({
  id: "text",
  name: "Written answers",
  description:
    "A written answer has at least three words, is not a repeated character or keyboard mashing, and is not the task's instructions copied back.",
  applies: { media: ["text"] },
  deterministic: true,
  verify({ job, work }) {
    const checks: Check[] = [];
    let accepted = 0;
    const material = job.instructions ? normalize(job.instructions) : "";
    work.forEach((piece, index) => {
      if (piece.kind !== "text") {
        accepted += 1;
        return;
      }
      const label = `text ${index + 1}`;
      const body = piece.text.trim();
      let ok = true;
      const count = words(body).length;
      if (count < MIN_WORDS) {
        checks.push({
          id: "words",
          ok: false,
          file: label,
          message: `${label} has ${count} word${count === 1 ? "" : "s"}; at least ${MIN_WORDS} needed`,
        });
        ok = false;
      }
      const run = longestRun(body);
      const distinct = new Set(body.replace(/\s+/gu, "")).size;
      const ratio = body.length ? distinct / body.replace(/\s+/gu, "").length : 0;
      if (run > MAX_RUN || (body.length >= 20 && ratio < MIN_DISTINCT_RATIO)) {
        checks.push({
          id: "gibberish",
          ok: false,
          file: label,
          message: `${label} does not read like an answer`,
          details: { longest_run: run, distinct_ratio: Math.round(ratio * 100) / 100 },
        });
        ok = false;
      }
      if (material && body.length >= 20 && material.includes(normalize(body))) {
        checks.push({ id: "copied", ok: false, file: label, message: `${label} is the task's own material pasted back` });
        ok = false;
      }
      if (ok) {
        checks.push({ id: "reads_as_answer", ok: true, file: label, message: `${label} reads as an answer (${count} words)` });
        accepted += 1;
      }
    });
    return { verifier: "text", outcome: checks.some((c) => !c.ok) ? "fail" : "pass", checks, accepted_units: accepted };
  },
});
