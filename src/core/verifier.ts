/**
 * Verifiers decide, from the work itself and the task's requirements, whether
 * work is complete and what it should pay. A deterministic verifier gives the
 * same verdict for the same input, uses no network and no randomness, and is
 * the only kind whose verdict may accept work and credit pay on its own.
 * "uncertain" is a first-class outcome: it means a person should look.
 */
import { z } from "zod";
import type { Logger } from "./connector.js";
import { ProtocolError } from "./errors.js";
import { isConnectorId } from "./ids.js";
import { MoneySchema, type Application, type Job, type MediaKind, type Money, type NativeJob, type ResolvedWork } from "./types.js";

export const OUTCOMES = ["pass", "fail", "uncertain"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const CheckSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  message: z.string(),
  /** The piece of work the check is about, when it is about one. */
  file: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type Check = z.infer<typeof CheckSchema>;

export const VerdictSchema = z
  .object({
    verifier: z.string().min(1),
    outcome: z.enum(OUTCOMES),
    checks: z.array(CheckSchema),
    /** Pieces of work this verifier counts as acceptable. */
    accepted_units: z.number().int().min(0).optional(),
  })
  .strict();
export type Verdict = z.infer<typeof VerdictSchema>;

export const VerificationSchema = z.object({
  outcome: z.enum(OUTCOMES),
  /** Every verdict came from a deterministic verifier, so a pass may accept the work on its own. */
  deterministic: z.boolean(),
  verdicts: z.array(VerdictSchema),
  accepted_units: z.number().int().min(0).optional(),
  /** What the accepted work pays at the task's per-unit rate. */
  pay: MoneySchema.optional(),
  summary: z.string(),
});
export type Verification = z.infer<typeof VerificationSchema>;

export type VerifyInput = {
  job: Job | NativeJob;
  work: ResolvedWork[];
  answers?: Record<string, string | string[]>;
  application?: Application;
};

export type VerifierContext = {
  log: Logger;
  signal: AbortSignal;
  /** sha256 hex of work accepted before, from the platform, so a resubmission fails. */
  known_fingerprints?: ReadonlySet<string>;
};

export type Applies = { media?: MediaKind[]; connectors?: string[]; tags?: string[] };

export interface Verifier {
  /** Lowercase letters, digits and dashes. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Which tasks it can judge. Omit for any. */
  readonly applies?: Applies;
  /** Same input, same verdict, no network, no randomness. */
  readonly deterministic: boolean;
  verify(input: VerifyInput, ctx: VerifierContext): Verdict | Promise<Verdict>;
}

export function defineVerifier<T extends Verifier>(verifier: T): T {
  if (!isConnectorId(verifier.id))
    throw new ProtocolError("invalid_input", `Verifier id ${JSON.stringify(verifier.id)} must be lowercase letters, digits and dashes.`);
  if (!verifier.name || !verifier.description)
    throw new ProtocolError("invalid_input", `Verifier ${verifier.id} needs a name and a description.`);
  if (typeof verifier.deterministic !== "boolean")
    throw new ProtocolError("invalid_input", `Verifier ${verifier.id} must say whether it is deterministic.`);
  if (typeof verifier.verify !== "function") throw new ProtocolError("invalid_input", `Verifier ${verifier.id} has no verify().`);
  return verifier;
}

/** The media a task's work is made of, from its requirements. */
export function mediaOf(job: Job | NativeJob): MediaKind[] {
  const kinds = job.requirements?.files?.kinds ?? [];
  const media = kinds.filter((k): k is MediaKind => k === "text" || k === "image" || k === "audio" || k === "video");
  if (job.requirements?.text && !media.includes("text")) media.push("text");
  return media;
}

export function verifierApplies(verifier: Verifier, job: Job | NativeJob): boolean {
  const a = verifier.applies;
  if (!a) return true;
  if (a.connectors?.length) {
    const connector = (job as Job).connector;
    if (!connector || !a.connectors.includes(connector)) return false;
  }
  if (a.media?.length && !mediaOf(job).some((m) => a.media!.includes(m))) return false;
  if (a.tags?.length && !(job.tags ?? []).some((t) => a.tags!.includes(t))) return false;
  return true;
}

/** fail beats uncertain beats pass; no verdict at all is uncertain. */
export function combineOutcomes(outcomes: Outcome[]): Outcome {
  if (outcomes.length === 0) return "uncertain";
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.includes("uncertain")) return "uncertain";
  return "pass";
}

/** What `units` pieces pay at the task's per-unit rate, or nothing when the task has no such rate. */
export function payFor(job: Job | NativeJob, units: number): Money | undefined {
  const pay = job.pay;
  if (!pay || pay.period !== "unit" || pay.min === undefined || !pay.currency || units <= 0) return undefined;
  return { amount: Math.round(pay.min * units * 100) / 100, currency: pay.currency };
}

/** One unit per piece of work. */
export function countUnits(work: ResolvedWork[]): number {
  return work.length;
}

export type VerifyOptions = {
  verifiers: Verifier[];
  ctx?: Partial<VerifierContext>;
  /** Budget for all verifiers together. Default 30 s. */
  timeoutMs?: number;
};

/** Runs every applicable verifier and combines the verdicts into one verification. */
export async function verifyWork(input: VerifyInput, options: VerifyOptions): Promise<Verification> {
  const applicable = options.verifiers.filter((v) => verifierApplies(v, input.job));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const ctx: VerifierContext = { log: () => {}, signal: controller.signal, ...options.ctx };
  const verdicts: Verdict[] = [];
  try {
    for (const verifier of applicable) {
      try {
        const raw = await verifier.verify(input, ctx);
        const parsed = VerdictSchema.safeParse({ ...raw, verifier: verifier.id });
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        verdicts.push(parsed.data);
      } catch (error) {
        ctx.log("verifier.failed", { verifier: verifier.id, message: error instanceof Error ? error.message : String(error) });
        verdicts.push({
          verifier: verifier.id,
          outcome: "uncertain",
          checks: [
            {
              id: "verifier_error",
              ok: false,
              message: `${verifier.name} could not run: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        });
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const outcome = combineOutcomes(verdicts.map((v) => v.outcome));
  const deterministic = applicable.length > 0 && applicable.every((v) => v.deterministic);
  const unitCounts = verdicts.filter((v) => v.accepted_units !== undefined).map((v) => v.accepted_units!);
  const accepted_units = outcome === "pass" ? (unitCounts.length ? Math.min(...unitCounts) : countUnits(input.work)) : 0;
  const pay = outcome === "pass" ? payFor(input.job, accepted_units) : undefined;
  const failed = verdicts.flatMap((v) => v.checks.filter((c) => !c.ok).map((c) => `${v.verifier}: ${c.message}`));
  const summary =
    outcome === "pass"
      ? `Pass: ${accepted_units} piece${accepted_units === 1 ? "" : "s"} accepted by ${verdicts.length} verifier${verdicts.length === 1 ? "" : "s"}${pay ? `, ${pay.currency} ${pay.amount}` : ""}${deterministic ? "" : " (not every verifier is deterministic; a person decides)"}.`
      : outcome === "fail"
        ? `Fail: ${failed.join("; ")}`
        : verdicts.length === 0
          ? "Uncertain: no verifier applies to this task."
          : `Uncertain: ${failed.join("; ") || "a check could not decide"}; a person should look.`;
  return { outcome, deterministic, verdicts, ...(outcome === "pass" ? { accepted_units } : {}), ...(pay ? { pay } : {}), summary };
}
