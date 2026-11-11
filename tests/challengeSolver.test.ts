import { describe, expect, it } from "vitest";
import { ProtocolError, type Application, type Job } from "../src/index.js";
import { MAX_ATTEMPTS, solveChallenges, type Work } from "../workflows/challenge-solver/solver.js";

const task = (id: string, title: string, tags: string[], extra: Partial<Job> = {}): Job => ({
  id: `kariaa:${id}`,
  connector: "kariaa",
  kind: "task",
  title,
  tags,
  stages: ["get", "apply", "upload", "submit", "status"],
  instructions: `Material for ${title}`,
  requirements: { looks_like: "One JSON object." },
  ...extra,
});

/** A stand-in for Kariaa: a challenge task accepts only the right answer and says why otherwise. */
function fakeWork(jobs: Job[], right: Record<string, string>) {
  const stage = new Map<string, Application["stage"]>();
  const calls: string[] = [];
  const app = (jobId: string): Application => ({
    id: jobId.replace("kariaa:", "kariaa:app-"),
    job_id: jobId,
    connector: "kariaa",
    stage: stage.get(jobId) ?? "work_needed",
  });
  const jobOf = (applicationId: string) => applicationId.replace("kariaa:app-", "kariaa:");
  const work: Work = {
    async search() {
      calls.push("search");
      return { jobs, more: false, partial: [] };
    },
    async get(id) {
      calls.push(`get ${id}`);
      return jobs.find((j) => j.id === id)!;
    },
    async apply(jobId) {
      calls.push(`apply ${jobId}`);
      stage.set(jobId, "work_needed");
      return app(jobId);
    },
    async upload(applicationId, input) {
      const jobId = jobOf(applicationId);
      calls.push(`upload ${jobId}`);
      if (input.text !== right[jobId])
        throw new ProtocolError(
          "invalid_input",
          "Not there yet (8 of 10): T4, T9 labelled differently. Fix it and send the answer again.",
          {
            connector: "kariaa",
            details: { kariaa_error: "challenge_failed" },
          },
        );
      return { application_id: applicationId, progress: { received: 1, wanted: 1, ready_to_submit: true } };
    },
    async submit(applicationId) {
      const jobId = jobOf(applicationId);
      calls.push(`submit ${jobId}`);
      stage.set(jobId, "accepted");
      return app(jobId);
    },
    async status(applicationId) {
      return app(jobOf(applicationId));
    },
  };
  return { work, calls };
}

describe("the challenge solver", () => {
  it("fixes an answer that is sent back and gets it accepted, and leaves tasks for people alone", async () => {
    const jobs = [task("c1", "Label ten support tickets", ["text", "agent-allowed"]), task("v1", "Everyday tasks on video", ["video"])];
    const { work, calls } = fakeWork(jobs, { "kariaa:c1": '{"T1":"billing"}' });
    const prompts: string[] = [];
    const ask = async (prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1 ? '{"T1":"bug"}' : ' {"T1":"billing"} ';
    };
    const results = await solveChallenges({ work, ask });
    expect(results).toEqual([{ job: "kariaa:c1", title: "Label ten support tickets", outcome: "accepted", attempts: 2 }]);
    // The task for people was never read, applied to or answered.
    expect(calls.some((c) => c.includes("v1"))).toBe(false);
    expect(calls).toEqual(["search", "get kariaa:c1", "apply kariaa:c1", "upload kariaa:c1", "upload kariaa:c1", "submit kariaa:c1"]);
    // The second ask carried the first answer and what the server said about it.
    expect(prompts[0]).toContain("Material for Label ten support tickets");
    expect(prompts[0]).toContain("A good answer looks like: One JSON object.");
    expect(prompts[1]).toContain('{"T1":"bug"}');
    expect(prompts[1]).toContain("T4, T9 labelled differently");
  });

  it("gives up after a few tries and never hands in an answer the check refused", async () => {
    const { work, calls } = fakeWork([task("c2", "Find the duplicate contacts", ["agent-allowed"])], { "kariaa:c2": "[]" });
    const results = await solveChallenges({ work, ask: async () => "wrong every time" });
    expect(results).toMatchObject([{ outcome: "gave_up", attempts: MAX_ATTEMPTS, feedback: expect.stringContaining("Not there yet") }]);
    expect(calls.filter((c) => c.startsWith("upload"))).toHaveLength(MAX_ATTEMPTS);
    expect(calls.some((c) => c.startsWith("submit"))).toBe(false);
  });

  it("skips a task whose full text does not say agents may do it, and stops on any other error", async () => {
    const listed = task("c3", "Looks open", ["agent-allowed"]);
    const { work } = fakeWork([listed], {});
    work.get = async () => ({ ...listed, tags: ["text"] });
    expect(await solveChallenges({ work, ask: async () => "x" })).toEqual([
      { job: "kariaa:c3", title: "Looks open", outcome: "skipped", attempts: 0 },
    ]);

    const broken = fakeWork([task("c4", "Needs a key", ["agent-allowed"])], {});
    broken.work.apply = async () => {
      throw new ProtocolError("auth_required", "Set KARIAA_API_KEY.");
    };
    await expect(solveChallenges({ work: broken.work, ask: async () => "x" })).rejects.toMatchObject({ code: "auth_required" });
  });

  it("adds a sentence when the server does not read a bare list as an answer", async () => {
    const { work } = fakeWork([task("c5", "Find the duplicate contacts", ["agent-allowed"])], {
      "kariaa:c5": 'The duplicate pairs are: [["C1","C3"]]',
    });
    const upload = work.upload.bind(work);
    work.upload = async (applicationId, input) => {
      if (input.text === '[["C1","C3"]]')
        throw new ProtocolError("invalid_input", "That does not read like an answer.", {
          connector: "kariaa",
          details: { kariaa_error: "looks_like_gibberish" },
        });
      return upload(applicationId, input);
    };
    const prompts: string[] = [];
    const results = await solveChallenges({
      work,
      ask: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? '[["C1","C3"]]' : 'The duplicate pairs are: [["C1","C3"]]';
      },
    });
    expect(results).toMatchObject([{ outcome: "accepted", attempts: 2 }]);
    expect(prompts[1]).toContain("put one plain sentence in front of it");
  });

  it("says so when nothing is open to agents", async () => {
    const lines: string[] = [];
    const { work } = fakeWork([task("v1", "Everyday tasks on video", ["video"])], {});
    expect(await solveChallenges({ work, ask: async () => "x", log: (line) => lines.push(line) })).toEqual([]);
    expect(lines).toEqual(["No task here is marked for agents right now."]);
  });
});
