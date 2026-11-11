/**
 * Ledger: one page that says where a person's money stands across every platform they have linked.
 * What needs them today, what is waiting on someone else, what was accepted, and what each balance is.
 * It only reads: nothing is applied to, sent or paid out.
 *
 *   work trace -- npx tsx workflows/ledger/run.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createProtocol, ProtocolError, type Application, type Earnings } from "../../src/index.js";

/** Stages where the next move is the person's. */
const YOURS = new Set(["work_needed"]);
const DONE = new Set(["accepted"]);
const CLOSED = new Set(["rejected", "withdrawn", "closed"]);

const money = (m?: { amount: number; currency: string }) => (m ? `${m.currency} ${m.amount}` : "not stated");

export function ledger(applications: Application[], earnings: Earnings[], silent: string[]): string {
  const yours = applications.filter((a) => YOURS.has(a.stage));
  const done = applications.filter((a) => DONE.has(a.stage));
  const waiting = applications.filter((a) => !YOURS.has(a.stage) && !DONE.has(a.stage) && !CLOSED.has(a.stage));
  const line = (a: Application) =>
    `- **${a.job_title ?? a.job_id}** (${a.connector}, ${a.stage})${a.next ? `: ${a.next}` : ""}\n  \`${a.id}\``;
  const out = ["# Ledger", ""];

  out.push(`## Needs you (${yours.length})`, "", ...(yours.length ? yours.map(line) : ["Nothing is waiting on you."]), "");
  out.push(
    `## Waiting on someone else (${waiting.length})`,
    "",
    ...(waiting.length ? waiting.map(line) : ["Nothing is out for review."]),
    "",
  );
  out.push(`## Accepted (${done.length})`, "", ...(done.length ? done.map(line) : ["Nothing accepted yet."]), "");

  out.push("## Money", "");
  if (!earnings.length) out.push("No linked platform reports earnings yet.");
  for (const e of earnings) {
    out.push(`- **${e.connector}**: balance ${money(e.balance)}, pending ${money(e.pending)}, earned so far ${money(e.total_earned)}`);
    if (e.min_payout && e.balance.amount >= e.min_payout.amount) out.push(`  Enough to pay out (from ${money(e.min_payout)}).`);
  }
  if (silent.length) out.push("", `Did not answer: ${silent.join(", ")}.`);
  return `${out.join("\n")}\n`;
}

async function main(): Promise<void> {
  const work = await createProtocol(); // reads every key in .env
  try {
    const accounts = await work.accounts();
    const linked = accounts.filter((a) => a.signed_in).map((a) => a.connector);
    if (!linked.length) {
      console.log("No platform is linked yet. Set KARIAA_API_KEY in .env, or run: work connect");
      return;
    }
    console.log(`linked: ${linked.join(", ")}`);

    const mine = await work.list();
    const paid = await work.earnings();
    const silent = [...new Set([...mine.partial, ...paid.partial].filter((p) => p.error.code !== "not_supported").map((p) => p.connector))];

    const page = ledger(mine.applications, paid.earnings, silent);
    const file = path.join(".work", "ledger.md");
    mkdirSync(".work", { recursive: true });
    writeFileSync(file, page);

    const yours = mine.applications.filter((a) => YOURS.has(a.stage)).length;
    console.log(`${mine.applications.length} applications on ${linked.length} platforms, ${yours} waiting on you. Ledger: ${file}`);
  } catch (error) {
    if (error instanceof ProtocolError) console.error(`${error.code}: ${error.message}`);
    else throw error;
    process.exitCode = 1;
  } finally {
    await work.close();
  }
}

if (process.argv[1]?.replace(/\\/gu, "/").endsWith("workflows/ledger/run.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
