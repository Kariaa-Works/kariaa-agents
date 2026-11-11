/**
 * Scout: finds work that fits a person, reads the best matches in full, checks a
 * draft against each one's requirements, and writes a shortlist.
 *
 *   work trace -- npx tsx workflows/scout/run.ts
 *   work trace -- npx tsx workflows/scout/run.ts --apply     (needs KARIAA_API_KEY)
 *
 * Finding, reading and checking need no key. `--apply` applies to at most one
 * Kariaa task, as the owner of KARIAA_API_KEY, and only when the answers in
 * profile.json pass the task's own checks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProtocol, ProtocolError, type Job } from "../../src/index.js";

type Profile = {
  name: string;
  skills: string[];
  searches: string[];
  kind?: "task" | "listing";
  remote?: boolean;
  intro: string;
  /** What the person has said about themselves, by question id. Nothing else is ever sent as an answer. */
  answers?: Record<string, string | string[]>;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(fs.readFileSync(path.join(here, "profile.json"), "utf8")) as Profile;
const wantsApply = process.argv.includes("--apply");
/** Writes made per run. One is enough to prove the loop; more is noise for real reviewers. */
const MAX_APPLIES = 1;

/** Stages that mean the agent can act on the job here, not only read it. */
const ACTIONABLE = ["apply", "upload", "submit"] as const;

function score(job: Job): { points: number; why: string[] } {
  const text = `${job.title} ${job.summary ?? ""} ${(job.tags ?? []).join(" ")}`.toLowerCase();
  const why: string[] = [];
  let points = 0;
  const matched = profile.skills.filter((skill) => text.includes(skill.toLowerCase()));
  if (matched.length) {
    points += matched.length * 3;
    why.push(`matches ${matched.join(", ")}`);
  }
  const actionable = ACTIONABLE.filter((stage) => job.stages.includes(stage));
  if (actionable.length) {
    points += 2 + actionable.length;
    why.push(`can ${actionable.join(" + ")} through the API`);
  }
  if (job.pay?.text || job.pay?.min !== undefined) {
    points += 1;
    why.push(`pay stated: ${job.pay.text ?? `${job.pay.min} ${job.pay.currency ?? ""}`.trim()}`);
  }
  if (profile.remote && job.location?.remote) points += 1;
  return { points, why };
}

/**
 * The job's questions that the profile answers. A question the person has not
 * answered is left out, and the check then says so: the workflow never makes
 * an answer up.
 */
function answersFor(job: Job): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  for (const question of job.requirements?.questions ?? []) {
    const known = profile.answers?.[question.id];
    if (known !== undefined) answers[question.id] = known;
  }
  return answers;
}

async function main(): Promise<void> {
  const protocol = await createProtocol(); // reads .env
  const lines: string[] = [`# Shortlist for ${profile.name}`, ""];
  try {
    // 1. Find: one search per phrase, merged by id.
    const found = new Map<string, Job>();
    for (const query of profile.searches) {
      const result = await protocol.search({
        query,
        limit: 10,
        ...(profile.kind ? { kind: profile.kind } : {}),
        ...(profile.remote ? { remote: true } : {}),
      });
      for (const job of result.jobs) found.set(job.id, job);
      for (const miss of result.partial) console.error(`  ${miss.connector} did not answer: ${miss.error.code}`);
      console.log(`search "${query}": ${result.jobs.length} results`);
    }

    // 2. Rank, then read the best three in full.
    const ranked = [...found.values()]
      .map((job) => ({ job, ...score(job) }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 3);
    let applied = 0;
    for (const pick of ranked) {
      let job = pick.job;
      try {
        job = await protocol.get(pick.job.id);
      } catch (error) {
        console.error(`  could not read ${pick.job.id}: ${error instanceof ProtocolError ? error.code : String(error)}`);
      }
      lines.push(
        `## ${job.title}${job.org ? ` · ${job.org}` : ""}`,
        "",
        `- id: \`${job.id}\``,
        `- why: ${pick.why.join("; ") || "closest match"}`,
      );
      if (job.pay?.text) lines.push(`- pay: ${job.pay.text}`);
      if (job.url) lines.push(`- link: ${job.url}`);
      if (job.apply_hint) lines.push(`- how to apply: ${job.apply_hint}`);

      // 3. Verify: check a draft against the job's own requirements before anything is sent.
      const answers = answersFor(job);
      const required = (job.requirements?.questions ?? []).filter((q) => q.required);
      const missing = required.filter((q) => answers[q.id] === undefined);
      let answersPass = false;
      if (required.length && missing.length) {
        lines.push(`- needs from you: ${missing.map((q) => q.question).join("; ")}`);
      } else if (Object.keys(answers).length) {
        try {
          const check = await protocol.verify(job.id, [], answers);
          // Work comes after applying; here only the answers are judged.
          const answerProblems = check.verdicts.flatMap((v) => v.checks).filter((c) => !c.ok && /answer/iu.test(c.message));
          answersPass = answerProblems.length === 0;
          lines.push(
            `- answers check: **${answersPass ? "pass" : "fail"}**${answersPass ? "" : ` · ${answerProblems.map((c) => c.message).join("; ")}`}`,
          );
        } catch (error) {
          lines.push(`- answers check: skipped (${error instanceof ProtocolError ? error.code : "error"})`);
        }
      }

      // 4. Apply: only when asked, only on Kariaa, only once.
      if (wantsApply && applied < MAX_APPLIES && job.connector === "kariaa" && job.stages.includes("apply") && !answersPass) {
        lines.push("- not applied: the answers have to pass the task's check first");
      }
      if (wantsApply && applied < MAX_APPLIES && answersPass && job.connector === "kariaa" && job.stages.includes("apply")) {
        try {
          const application = await protocol.apply(job.id, { answers, note: profile.intro });
          applied += 1;
          lines.push(
            `- applied: \`${application.id}\` is **${application.stage}**${application.next ? ` · next: ${application.next}` : ""}`,
          );
        } catch (error) {
          const err = error instanceof ProtocolError ? error : undefined;
          lines.push(`- apply failed: ${err ? `${err.code}: ${err.message}` : String(error)}`);
        }
      }
      lines.push("");
    }

    // 5. Track: with a key, show where earlier applications stand.
    if (process.env.KARIAA_API_KEY) {
      lines.push("## Applications so far", "");
      try {
        const mine = await protocol.list("kariaa");
        if (mine.applications.length === 0) lines.push("None yet.");
        for (const application of mine.applications.slice(0, 10))
          lines.push(`- ${application.job_title ?? application.job_id}: **${application.stage}**`);
      } catch (error) {
        lines.push(`Could not read them: ${error instanceof ProtocolError ? error.code : "error"}`);
      }
      lines.push("");
    }

    const out = path.resolve(".work", "shortlist.md");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, lines.join("\n"), "utf8");
    console.log(`\n${ranked.length} picks from ${found.size} results. Shortlist: ${path.relative(process.cwd(), out)}`);
  } finally {
    await protocol.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
