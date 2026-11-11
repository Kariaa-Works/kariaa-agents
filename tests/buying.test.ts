import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/index.js";
import { stagesOf } from "../src/core/connector.js";
import { describeBuyerConformance } from "../src/core/conformance.js";
import { PayConfirm } from "../src/core/payConfirm.js";
import { WorkProtocol } from "../src/core/router.js";
import { createWorkMcpServer } from "../src/mcp/server.js";
import { fakeMarket } from "./helpers/fakeMarket.js";
import { searchOnlyConnector } from "./helpers/fakeConnectors.js";

const JOB = {
  title: "Translate a product page into Spanish",
  description: "Translate the 600-word page at the link into neutral Latin American Spanish. Keep the headings and the HTML tags.",
  budget: { amount: 30, currency: "USD" },
  acceptance: ["Every heading and paragraph is translated", "No machine-translation artefacts"],
};

function setup() {
  const market = fakeMarket();
  const protocol = new WorkProtocol({ connectors: [market, searchOnlyConnector()], env: {}, cache: null });
  return { market, protocol };
}

describe("giving work out", () => {
  it("derives the buyer stages from what a connector implements", () => {
    expect(stagesOf(fakeMarket())).toEqual(["post", "postings", "offers", "award", "review", "pay", "cancel"]);
  });

  it("posts, reads offers, awards, reviews and pays, and money moves only after a confirm", async () => {
    const { market, protocol } = setup();

    const posting = await protocol.post("fake-market", JOB);
    expect(posting).toMatchObject({ id: "fake-market:p1", connector: "fake-market", status: "open", funded: false });
    expect((await protocol.postings()).postings.map((p) => p.id)).toEqual(["fake-market:p1"]);

    market.bid("p1", {
      id: "o1",
      from: { name: "Ana", kind: "human", rating: 4.9 },
      amount: { amount: 28, currency: "USD" },
      days: 2,
      note: "Native speaker.",
    });
    market.bid("p1", { id: "o2", from: { name: "translator-bot", kind: "agent" }, amount: { amount: 12, currency: "USD" }, days: 1 });
    const read = await protocol.offers(posting.id);
    expect(read.offers.map((o) => [o.id, o.from.kind, o.amount?.amount])).toEqual([
      ["o1", "human", 28],
      ["o2", "agent", 12],
    ]);

    expect(await protocol.award(posting.id, "o1")).toMatchObject({ status: "assigned", awarded_offer: "o1" });

    // Funding: the first call only says what would happen.
    const ask = await protocol.pay(posting.id, { action: "fund" });
    expect(ask).toMatchObject({ status: "confirm_needed", action: "fund", amount: { amount: 28, currency: "USD" }, fee: { amount: 2.8 } });
    expect(ask.confirm).toMatch(/^pay\.[0-9a-z]+\.[0-9a-f]{24}$/u);
    expect(market.moved).toEqual([]);

    // A token nobody issued, and one issued by another machine, are refused, and still nothing moves.
    const foreign = new PayConfirm("someone-else-someone-else-someone-else").issue({
      posting: posting.id,
      action: "fund",
      amount: { amount: 28, currency: "USD" },
    });
    for (const forged of ["pay-0123456789abcdef", foreign]) {
      const wrong = await protocol.pay(posting.id, { action: "fund", confirm: forged });
      expect(wrong.status).toBe("confirm_needed");
      expect(wrong.next).toContain("not for these terms");
    }
    // Different terms need their own confirmation: the token for 28 does not pay 5.
    const other = await protocol.pay(posting.id, { action: "fund", amount: { amount: 5, currency: "usd" }, confirm: ask.confirm });
    expect(other).toMatchObject({ status: "confirm_needed", amount: { amount: 5, currency: "USD" } });
    expect(other.confirm).not.toBe(ask.confirm);
    expect(market.moved).toEqual([]);

    expect(await protocol.pay(posting.id, { action: "fund", confirm: ask.confirm })).toMatchObject({
      status: "funded",
      connector: "fake-market",
    });
    expect(market.moved).toEqual([{ posting: "p1", action: "fund", amount: 28, currency: "USD" }]);

    // Releasing before the work is accepted is refused by the platform.
    await expect(protocol.pay(posting.id, { action: "release" })).rejects.toMatchObject({ code: "wrong_stage" });

    market.deliver("p1", "Aquí está la traducción completa…");
    expect((await protocol.offers(posting.id)).offers[0]).toMatchObject({
      status: "delivered",
      delivery: { text: expect.stringContaining("traducción") },
    });

    await expect(protocol.review(posting.id, { decision: "request_changes" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await protocol.review(posting.id, { decision: "accept" })).toMatchObject({ status: "completed" });

    const release = await protocol.pay(posting.id);
    expect(release).toMatchObject({ status: "confirm_needed", action: "release", to: "Ana" });
    const done = await protocol.pay(posting.id, { confirm: release.confirm });
    expect(done.status).toBe("released");
    expect(market.moved.at(-1)).toEqual({ posting: "p1", action: "release", amount: 28, currency: "USD", to: "Ana" });
  });

  it("says not_supported where a platform has no buyer side, and not_found for a posting that is not yours", async () => {
    const { protocol } = setup();
    await expect(protocol.post("fake-board", JOB)).rejects.toMatchObject({ code: "not_supported" });
    await expect(protocol.offers("fake-market:nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(protocol.post("fake-market", { ...JOB, title: "x" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("cancels a posting and says what happens to the money", async () => {
    const { protocol } = setup();
    const posting = await protocol.post("fake-market", JOB);
    expect(await protocol.cancelPosting(posting.id)).toMatchObject({ status: "cancelled", next: "Nothing was set aside." });
  });
});

describe("giving work out, over MCP and the command line", () => {
  it("runs the same loop through the tools", async () => {
    const { market, protocol } = setup();
    const server = createWorkMcpServer(protocol);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent: Record<string, unknown>;
        content: Array<{ text: string }>;
      };

    const posted = await call("post_job", { connector: "fake-market", ...JOB, workers: "human" });
    expect(posted.isError).toBeFalsy();
    const id = posted.structuredContent.id as string;
    market.bid("p1", { id: "o1", from: { name: "Ana", kind: "human" }, amount: { amount: 30, currency: "USD" } });

    const offers = await call("list_offers", { posting_id: id });
    expect(offers.structuredContent.count).toBe(1);
    expect(offers.content[0]!.text).toContain("Ana");
    await call("award_offer", { posting_id: id, offer_id: "o1" });

    const ask = await call("pay_for_work", { posting_id: id, action: "fund" });
    expect(ask.structuredContent.status).toBe("confirm_needed");
    expect(ask.content[0]!.text).toContain("Nothing has moved yet");
    expect(market.moved).toHaveLength(0);
    const paid = await call("pay_for_work", { posting_id: id, action: "fund", confirm: ask.structuredContent.confirm });
    expect(paid.structuredContent.status).toBe("funded");

    const early = await call("review_work", { posting_id: id, decision: "accept" });
    expect(early.isError).toBe(true);
    expect(early.structuredContent.error).toBe("wrong_stage");
    expect((await call("my_postings", {})).structuredContent.count).toBe(1);
    await client.close();
  });

  it("runs the same loop from the terminal", async () => {
    const { market, protocol } = setup();
    const run = async (...argv: string[]) => {
      const box = { out: "", err: "" };
      const code = await main(argv, { stdout: (t) => (box.out += t), stderr: (t) => (box.err += t), env: {}, protocol });
      return { code, ...box };
    };
    const posted = await run(
      "post",
      "--connector",
      "fake-market",
      "--title",
      JOB.title,
      "--description",
      JOB.description,
      "--budget",
      "30",
      "--currency",
      "USD",
      "--json",
    );
    expect(posted.code).toBe(0);
    const id = (JSON.parse(posted.out) as { id: string }).id;
    market.bid("p1", { id: "o1", from: { name: "Ana" }, amount: { amount: 30, currency: "USD" } });
    expect((await run("offers", id)).out).toContain("o1 · Ana");
    expect((await run("award", id, "o1")).out).toContain("assigned");
    const ask = await run("pay", id, "fund");
    expect(ask.out).toContain("Nothing has moved yet");
    const token = /Confirm token: (\S+)/u.exec(ask.out)![1]!;
    expect((await run("pay", id, "fund", "--confirm", token)).out).toContain("Set aside: funded");
    expect((await run("review", id, "maybe")).err).toContain("accept, changes or reject");
    expect((await run("posted")).out).toContain("money set aside");
    expect((await run("post", "--connector", "fake-market", "--title", "x")).err).toContain("budget");
  });
});

describe("the confirm step", () => {
  const terms = { posting: "m:p1", action: "release", amount: { amount: 28, currency: "USD" }, to: "Ana" };

  it("accepts its own token for the same terms, until it runs out", () => {
    const confirm = new PayConfirm("secret-secret-secret-secret-secret");
    const token = confirm.issue(terms, 1_000_000);
    expect(confirm.check(token, terms, 1_000_000)).toBe("ok");
    expect(confirm.check(token, terms, 1_000_000 + 16 * 60_000)).toBe("expired");
    expect(confirm.check(undefined, terms)).toBe("missing");
  });

  it("refuses a token when the amount, the receiver, the offer, the fee or the posting changed", () => {
    const confirm = new PayConfirm("secret-secret-secret-secret-secret");
    const token = confirm.issue(terms);
    expect(confirm.check(token, { ...terms, amount: { amount: 29, currency: "USD" } })).toBe("mismatch");
    expect(confirm.check(token, { ...terms, to: "Bob" })).toBe("mismatch");
    expect(confirm.check(token, { ...terms, offer: "o2" })).toBe("mismatch");
    expect(confirm.check(token, { ...terms, posting: "m:p2" })).toBe("mismatch");
    expect(confirm.check(token, { ...terms, fee: { amount: 3, currency: "USD" } })).toBe("mismatch");
    expect(new PayConfirm("another-secret-another-secret-xx").check(token, terms)).toBe("mismatch");
  });

  it("never confirms a payment without an amount", async () => {
    const market = fakeMarket("no-quote");
    delete (market as { quote?: unknown }).quote;
    const protocol = new WorkProtocol({ connectors: [market], env: {}, cache: null });
    const posting = await protocol.post("no-quote", JOB);
    await expect(protocol.pay(posting.id, { action: "fund" })).rejects.toMatchObject({ code: "invalid_input" });
    const ask = await protocol.pay(posting.id, { action: "fund", amount: { amount: 30, currency: "usd" } });
    expect(ask).toMatchObject({ status: "confirm_needed", amount: { amount: 30, currency: "USD" } });
  });

  it("does not let a discover-tier platform post or pay: the person does that on the site", async () => {
    const market = Object.assign(fakeMarket("hands-off"), { tier: "discover" as const });
    const protocol = new WorkProtocol({ connectors: [market], env: {}, cache: null });
    await expect(protocol.post("hands-off", JOB)).rejects.toMatchObject({ code: "handoff_required" });
  });
});

// The in-memory market answers without the network, so the buyer suite can run against it as it is.
describeBuyerConformance(fakeMarket("conformance-market"), { fetch: (async () => new Response("{}")) as typeof fetch, post: JOB });
