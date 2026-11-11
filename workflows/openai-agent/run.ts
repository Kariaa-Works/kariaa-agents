/**
 * OpenAI agent: an OpenAI model decides which Work API tools to call to reach a goal.
 * The loop and its guards are the ones in agent.ts.
 *
 *   work trace -- npx tsx workflows/openai-agent/run.ts "Find three paid tasks an agent could act on today"
 *   work trace -- npx tsx workflows/openai-agent/run.ts --act "Apply to the best Kariaa task for a careful data labeler"
 *
 * Needs OPENAI_API_KEY. OPENAI_MODEL picks the model. Without --act the agent
 * can only read; with --act it may apply, add work and submit, a few times at most.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadDotEnv } from "../../src/index.js";
import { runAgent } from "./agent.js";
import { openAiModel } from "./openai.js";

async function main(): Promise<void> {
  loadDotEnv(); // OPENAI_API_KEY and KARIAA_API_KEY from .env
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error("Set OPENAI_API_KEY in .env to run this workflow.");
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2);
  const act = args.includes("--act");
  const goal = args.filter((arg) => arg !== "--act").join(" ") || "Find three tasks I could start today and say what each one needs.";

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const work = new Client({ name: "openai-agent", version: "1.0.0" });
  await work.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist", "cli", "index.js"), "mcp"],
      cwd: root,
      env: process.env as Record<string, string>,
    }),
  );
  try {
    const result = await runAgent({
      goal,
      act,
      work,
      model: openAiModel({
        apiKey,
        model: process.env.OPENAI_MODEL?.trim() || "gpt-5-mini",
        ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
      }),
      log: (line) => console.log(line),
    });
    if (result.ended === "turn_limit") console.error("Stopped at the turn limit.");
  } finally {
    await work.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
