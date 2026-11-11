/**
 * Does Kariaa's challenge tasks from start to finish: find the tasks an agent may
 * do, read each one, ask a model for the answer, hand it in, and when the
 * server's check sends it back, fix it and try again.
 *
 * The Work API and the model are passed in, so the loop is tested without either
 * (tests/challengeSolver.test.ts).
 */
import {
  ProtocolError,
  type Application,
  type Job,
  type SearchQuery,
  type SearchResult,
  type WorkInput,
  type WorkReceipt,
} from "../../src/index.js";

/** The part of the Work API the solver uses. */
export type Work = {
  search(query: SearchQuery): Promise<SearchResult>;
  get(id: string): Promise<Job>;
  apply(jobId: string, input?: { note?: string }): Promise<Application>;
  upload(applicationId: string, work: WorkInput): Promise<WorkReceipt & { application_id: string }>;
  submit(applicationId: string): Promise<Application>;
  status(applicationId: string): Promise<Application>;
};

/** Ask a model one question and get its text back. */
export type Ask = (prompt: string) => Promise<string>;

export type Solved = {
  job: string;
  title: string;
  outcome: "accepted" | "in_review" | "gave_up" | "skipped";
  attempts: number;
  /** What the server said about the last attempt that fell short. */
  feedback?: string;
};

export const MAX_ATTEMPTS = 3;

function prompt(job: Job, feedback?: { answer: string; notes: string }): string {
  const parts = [
    "Do this task exactly as it is written. Reply with the answer only, in the form the task asks for, with no explanation around it.",
    `Task: ${job.title}`,
    job.instructions ?? job.description ?? "",
  ];
  if (job.requirements?.looks_like) parts.push(`A good answer looks like: ${job.requirements.looks_like}`);
  if (feedback)
    parts.push(
      `Your last answer was:\n${feedback.answer}\n\nIt was sent back with this: ${feedback.notes}\nFix exactly that and reply with the whole corrected answer.`,
    );
  return parts.filter(Boolean).join("\n\n");
}

/**
 * What the server said when it sent the answer back for another try, or undefined when the call
 * failed for some other reason. Two cases come back: the challenge's own check, and the plain-text
 * check that runs first and does not read a bare list of ids as an answer.
 */
function sentBack(error: unknown): string | undefined {
  if (!(error instanceof ProtocolError) || error.code !== "invalid_input") return undefined;
  const reason = (error.details as { kariaa_error?: string } | undefined)?.kariaa_error;
  if (reason === "challenge_failed") return error.message;
  if (reason === "looks_like_gibberish")
    return "The answer was not read as text. Keep the same answer, and put one plain sentence in front of it saying what it is.";
  return undefined;
}

export async function solveChallenges(options: {
  work: Work;
  ask: Ask;
  /** How many tasks to take in one run. */
  limit?: number;
  log?: (line: string) => void;
}): Promise<Solved[]> {
  const log = options.log ?? (() => {});
  const found = await options.work.search({ connectors: ["kariaa"], kind: "task", limit: 20 });
  const open = found.jobs.filter((job) => (job.tags ?? []).includes("agent-allowed")).slice(0, options.limit ?? 4);
  if (open.length === 0) log("No task here is marked for agents right now.");

  const results: Solved[] = [];
  for (const listed of open) {
    const job = await options.work.get(listed.id);
    // Only work the task itself says an agent may do, and only text an agent can honestly write.
    if (!(job.tags ?? []).includes("agent-allowed") || !job.stages.includes("apply") || !(job.instructions ?? job.description)) {
      results.push({ job: job.id, title: job.title, outcome: "skipped", attempts: 0 });
      continue;
    }
    log(`\n${job.title}`);
    const application = await options.work.apply(job.id, { note: "An AI agent, taking this challenge." });
    if (application.stage === "accepted") {
      results.push({ job: job.id, title: job.title, outcome: "accepted", attempts: 0 });
      continue;
    }

    let feedback: { answer: string; notes: string } | undefined;
    let outcome: Solved["outcome"] = "gave_up";
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      const answer = (await options.ask(prompt(job, feedback))).trim();
      try {
        await options.work.upload(application.id, { text: answer });
      } catch (error) {
        const notes = sentBack(error);
        if (!notes) throw error;
        log(`  attempt ${attempts}: sent back. ${notes}`);
        feedback = { answer, notes };
        continue;
      }
      const sent = await options.work.submit(application.id);
      const now = sent.stage === "accepted" ? sent : await options.work.status(application.id);
      outcome = now.stage === "accepted" ? "accepted" : "in_review";
      log(`  attempt ${attempts}: ${outcome === "accepted" ? "accepted" : "handed in, waiting for review"}`);
      break;
    }
    results.push({
      job: job.id,
      title: job.title,
      outcome,
      attempts,
      ...(outcome === "gave_up" && feedback ? { feedback: feedback.notes } : {}),
    });
  }
  return results;
}
