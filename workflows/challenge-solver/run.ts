/**
 * Challenge solver: an agent that finishes Kariaa's challenge tasks end to end.
 *
 *   work trace -- npx tsx workflows/challenge-solver/run.ts
 *
 * Needs KARIAA_API_KEY (it applies and hands work in as that account) and a
 * model key, OPENAI_API_KEY. It only takes tasks the
 * server marks as open to agents. The loop is in solver.ts.
 */
import { createProtocol } from "../../src/index.js";
import { openAiModel } from "../openai-agent/openai.js";
import { solveChallenges, type Ask } from "./solver.js";

function model(): Ask | undefined {
  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    const call = openAiModel({ apiKey: openai, model: process.env.OPENAI_MODEL?.trim() || "gpt-5-mini" });
    return async (prompt) => {
      const reply = await call({
        system: "You do small, exact tasks. You answer with the result only.",
        tools: [],
        messages: [{ role: "user", content: prompt }],
      });
      return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    };
  }
  return undefined;
}

async function main(): Promise<void> {
  const work = await createProtocol(); // reads .env
  try {
    const ask = model();
    if (!ask) {
      console.error("Set OPENAI_API_KEY and KARIAA_API_KEY in .env: a model writes the answers, and a Kariaa key hands them in.");
      process.exitCode = 1;
      return;
    }
    if (!process.env.KARIAA_API_KEY) console.error("No KARIAA_API_KEY: the solver can look, but applying and handing work in need one.");
    const results = await solveChallenges({ work, ask, log: (line) => console.log(line) });
    const accepted = results.filter((r) => r.outcome === "accepted").length;
    if (results.length) console.log(`\n${accepted} of ${results.length} accepted.`);
    for (const r of results.filter((x) => x.outcome === "gave_up"))
      console.log(`Gave up on "${r.title}" after ${r.attempts} tries: ${r.feedback ?? ""}`);
  } finally {
    await work.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
