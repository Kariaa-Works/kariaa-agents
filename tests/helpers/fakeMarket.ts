/**
 * An in-memory marketplace seen from the buyer's side: post a job, read the
 * offers, pick one, review the delivery, set money aside and release it.
 * Tests use it to exercise the "giving work out" half of the protocol.
 */
import { defineConnector, type Connector } from "../../src/core/connector.js";
import { ProtocolError } from "../../src/core/errors.js";
import type { NativePayment, NativePosting, Offer, PayInput } from "../../src/core/types.js";

export type FakeMarket = Connector & {
  /** Every payment the platform carried out, in order. */
  moved: Array<{ posting: string; action: "fund" | "release"; amount: number; currency: string; to?: string }>;
  /** Make a worker bid on a posting. */
  bid(postingId: string, offer: Partial<Offer> & { id: string }): void;
  /** Make the awarded worker hand something in. */
  deliver(postingId: string, text: string): void;
};

export function fakeMarket(id = "fake-market", fee = 0.1): FakeMarket {
  const postings = new Map<string, NativePosting>();
  const offers = new Map<string, Offer[]>();
  const moved: FakeMarket["moved"] = [];
  let next = 1;

  const mine = (postingId: string): NativePosting => {
    const posting = postings.get(postingId);
    if (!posting) throw new ProtocolError("not_found", `No posting ${postingId}.`);
    return posting;
  };

  const terms = (postingId: string, input: PayInput): NativePayment => {
    const posting = mine(postingId);
    const action = input.action ?? (posting.funded ? "release" : "fund");
    const offer = (offers.get(postingId) ?? []).find((o) => o.id === (input.offer ?? posting.awarded_offer));
    const amount = input.amount ?? offer?.amount ?? posting.budget;
    if (!amount) throw new ProtocolError("invalid_input", "Say how much.");
    if (action === "release" && !posting.funded) throw new ProtocolError("not_ready", "Set the money aside first.");
    if (action === "release" && posting.status !== "completed")
      throw new ProtocolError("wrong_stage", "Accept the work first.", { details: { stage: posting.status } });
    return {
      status: "confirm_needed",
      action,
      amount,
      ...(action === "release" && offer?.from.name ? { to: offer.from.name } : {}),
      fee: { amount: Math.round(amount.amount * fee * 100) / 100, currency: amount.currency },
    };
  };

  const connector = defineConnector({
    id,
    name: "Fake Market",
    description: "An in-memory marketplace for tests.",
    kinds: ["task"],
    auth: { type: "none" },

    async post(input) {
      const posting: NativePosting = {
        id: `p${next++}`,
        title: input.title,
        status: "open",
        budget: input.budget,
        funded: false,
        offers: 0,
        next: "Wait for offers, then award one.",
      };
      postings.set(posting.id, posting);
      offers.set(posting.id, []);
      return posting;
    },
    async postings() {
      return [...postings.values()];
    },
    async offers(postingId) {
      const posting = postings.get(postingId);
      return posting ? { posting, offers: offers.get(postingId) ?? [] } : null;
    },
    async award(postingId, offerId) {
      const posting = mine(postingId);
      const list = offers.get(postingId) ?? [];
      const picked = list.find((o) => o.id === offerId);
      if (!picked) throw new ProtocolError("not_found", `No offer ${offerId} on ${postingId}.`);
      for (const offer of list) offer.status = offer.id === offerId ? "awarded" : "rejected";
      Object.assign(posting, { status: "assigned", awarded_offer: offerId, next: "Set the money aside, then wait for the work." });
      return posting;
    },
    async review(postingId, input) {
      const posting = mine(postingId);
      const awarded = (offers.get(postingId) ?? []).find((o) => o.id === posting.awarded_offer);
      if (!awarded?.delivery)
        throw new ProtocolError("wrong_stage", "Nothing has been handed in yet.", { details: { stage: posting.status } });
      if (input.decision === "accept") {
        awarded.status = "accepted";
        Object.assign(posting, { status: "completed", next: "Release the payment." });
      } else if (input.decision === "request_changes") {
        awarded.status = "awarded";
        delete awarded.delivery;
        Object.assign(posting, { status: "assigned", next: `Asked for changes: ${input.note}` });
      } else {
        awarded.status = "rejected";
        Object.assign(posting, { status: "open", awarded_offer: undefined, next: "Rejected. Award another offer or cancel." });
      }
      return posting;
    },
    async quote(postingId, input) {
      return terms(postingId, input);
    },
    async pay(postingId, input) {
      const quote = terms(postingId, input);
      const posting = mine(postingId);
      moved.push({
        posting: postingId,
        action: quote.action!,
        amount: quote.amount!.amount,
        currency: quote.amount!.currency,
        ...(quote.to ? { to: quote.to } : {}),
      });
      if (quote.action === "fund") posting.funded = true;
      return { ...quote, id: `pay${moved.length}`, status: quote.action === "fund" ? "funded" : "released" };
    },
    async cancel(postingId) {
      const posting = mine(postingId);
      Object.assign(posting, {
        status: "cancelled",
        next: posting.funded ? "The money set aside goes back to you." : "Nothing was set aside.",
      });
      return posting;
    },
  });

  return Object.assign(connector, {
    moved,
    bid(postingId: string, offer: Partial<Offer> & { id: string }) {
      const posting = mine(postingId);
      const list = offers.get(postingId)!;
      list.push({ from: { name: "worker", kind: "human" }, status: "pending", ...offer });
      posting.offers = list.length;
    },
    deliver(postingId: string, text: string) {
      const posting = mine(postingId);
      const awarded = (offers.get(postingId) ?? []).find((o) => o.id === posting.awarded_offer);
      if (!awarded) throw new Error("nothing awarded");
      awarded.status = "delivered";
      awarded.delivery = { text };
      posting.status = "in_review";
    },
  }) as FakeMarket;
}
