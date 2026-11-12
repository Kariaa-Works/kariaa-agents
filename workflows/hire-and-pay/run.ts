/**
 * Hire and pay: an agent gives work out instead of taking it. It posts a job, compares the offers
 * that come in from a person and from another agent, picks one, checks what is handed in against
 * the acceptance criteria, and pays.
 *
 * It runs on the test marketplace that ships with the repo, so no real money moves and the two
 * workers are played by the script. Swap `market` for a connector with the paying side and the
 * agent's half does not change.
 *
 *   work trace -- npx tsx workflows/hire-and-pay/run.ts          stops before each payment
 *   work trace -- npx tsx workflows/hire-and-pay/run.ts --yes    confirms the payments
 */
import { createProtocol, ProtocolError, type Offer } from "../../src/index.js";
import { fakeMarket } from "../../tests/helpers/fakeMarket.js";

const JOB = {
  title: "Translate a product page into Spanish",
  description: "Translate the 600-word page at the link into neutral Latin American Spanish. Keep the headings and the HTML tags.",
  budget: { amount: 30, currency: "USD" },
  acceptance: ["Every heading is translated", "The HTML tags are kept"],
};
const HEADINGS = ["Características", "Precios", "Contacto"];

/** The offer to take: within budget, the best-rated first, then the cheaper one. An unrated worker ranks below a rated one. */
export function pick(offers: Offer[], budget: number): Offer | undefined {
  return offers
    .filter((o) => o.status === "pending" && o.amount !== undefined && o.amount.amount <= budget)
    .sort((a, b) => (b.from.rating ?? 0) - (a.from.rating ?? 0) || a.amount!.amount - b.amount!.amount)[0];
}

/** What is wrong with a delivery, as notes the worker can act on. Empty when it meets the criteria. */
export function shortfalls(delivery: string): string[] {
  const notes: string[] = [];
  const missing = HEADINGS.filter((heading) => !delivery.includes(heading));
  if (missing.length) notes.push(`These headings are not translated: ${missing.join(", ")}.`);
  if (!/<h2>.*<\/h2>/su.test(delivery)) notes.push("The HTML tags were dropped.");
  return notes;
}

async function main(): Promise<void> {
  const approve = process.argv.includes("--yes");
  const market = fakeMarket("test-market");
  const work = await createProtocol({ connectors: [market] });
  try {
    // 1. Post the job.
    const posting = await work.post("test-market", JOB);
    console.log(`posted: ${posting.title} (${JOB.budget.currency} ${JOB.budget.amount})`);

    // Two workers answer. On a real platform they arrive on their own.
    market.bid("p1", { id: "o1", from: { name: "Ana", kind: "human", rating: 4.9 }, amount: { amount: 28, currency: "USD" }, days: 2 });
    market.bid("p1", { id: "o2", from: { name: "translator-bot", kind: "agent" }, amount: { amount: 12, currency: "USD" }, days: 1 });

    // 2. Read the offers and pick one.
    const { offers } = await work.offers(posting.id);
    for (const o of offers) console.log(`offer: ${o.from.name} (${o.from.kind}) ${o.amount?.currency} ${o.amount?.amount}, ${o.days} days`);
    const chosen = pick(offers, JOB.budget.amount);
    if (!chosen) {
      console.log("No offer fits the budget. Nothing awarded.");
      return;
    }
    await work.award(posting.id, chosen.id);
    console.log(`awarded: ${chosen.from.name}`);

    // 3. Set the money aside. The first call moves nothing: it says what would move and gives a token.
    const fund = await work.pay(posting.id, { action: "fund" });
    console.log(`to set aside: ${fund.amount?.currency} ${fund.amount?.amount} plus a fee of ${fund.fee?.amount}`);
    if (!approve) {
      console.log("Stopped before paying. Run again with --yes to confirm payments.");
      return;
    }
    await work.pay(posting.id, { action: "fund", confirm: fund.confirm });

    // The worker hands the work in.
    market.deliver("p1", "<h2>Características</h2><p>…</p><h2>Precios</h2><p>…</p><h2>Contacto</h2><p>…</p>");

    // 4. Review it against the acceptance criteria.
    const delivered = (await work.offers(posting.id)).offers.find((o) => o.id === chosen.id);
    const notes = shortfalls(delivered?.delivery?.text ?? "");
    if (notes.length) {
      await work.review(posting.id, { decision: "request_changes", note: notes.join(" ") });
      console.log(`sent back: ${notes.join(" ")}`);
      return;
    }
    await work.review(posting.id, { decision: "accept" });
    console.log("accepted");

    // 5. Pay. Again two calls: what would move, then the confirmation.
    const release = await work.pay(posting.id);
    console.log(`to release: ${release.amount?.currency} ${release.amount?.amount} to ${release.to}`);
    const paid = await work.pay(posting.id, { confirm: release.confirm });
    console.log(`${paid.status}: ${market.moved.at(-1)?.currency} ${market.moved.at(-1)?.amount} to ${market.moved.at(-1)?.to}`);
  } catch (error) {
    if (error instanceof ProtocolError) console.error(`${error.code}: ${error.message}`);
    else throw error;
    process.exitCode = 1;
  } finally {
    await work.close();
  }
}

if (process.argv[1]?.replace(/\\/gu, "/").endsWith("workflows/hire-and-pay/run.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
