/**
 * Example workflow: TODO say in one line what it does.
 *
 *   work trace -- npx tsx workflows/example-workflow/run.ts
 */
import { createProtocol, ProtocolError } from "../../src/index.js";

async function main(): Promise<void> {
  const protocol = await createProtocol(); // reads KARIAA_API_KEY and any other keys from .env
  try {
    // 1. Find. Every result says what can be done with it here in `stages`.
    const found = await protocol.search({ query: "TODO what to look for", limit: 5 });
    console.log(`found ${found.jobs.length}`);
    const pick = found.jobs[0];
    if (!pick) return;

    // 2. Read the whole job: questions, rules, what the work must look like.
    const job = await protocol.get(pick.id);
    console.log(job.title, job.stages.join(", "));

    // 3. TODO do the work. Then check it before sending anything:
    //    const check = await protocol.verify(job.id, [{ text: draft }]);
    //    if (check.outcome !== "pass") return;

    // 4. TODO act, only on jobs whose stages allow it (needs a key):
    //    const application = await protocol.apply(job.id, { answers: {}, note: "" });
    //    await protocol.upload(application.id, { text: draft });
    //    await protocol.submit(application.id);
    //    console.log((await protocol.status(application.id)).stage);
  } catch (error) {
    // Every failure is a ProtocolError with a code: auth_required, not_supported, rate_limited, …
    if (error instanceof ProtocolError) console.error(`${error.code}: ${error.message}`);
    else throw error;
    process.exitCode = 1;
  } finally {
    await protocol.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
