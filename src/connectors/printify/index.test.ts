import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, jsonResponse, testContext } from "../../core/conformance.js";
import { NativeApplicationSchema, NativeEarningsSchema, NativeJobSchema, WorkReceiptSchema } from "../../core/types.js";
import { blueprintToJob, createPrintify, ordersFor, parseAnswers, pickVariants, printify } from "./index.js";

type Rec = Record<string, unknown>;

// No Printify account was available, so these are hand-made in the shapes the API reference documents
// (https://developers.printify.com/): ids and amounts are made up; money is in cents.
const BLUEPRINTS = [
  {
    id: 6,
    title: "Unisex Heavy Cotton Tee",
    brand: "Gildan",
    model: "5000",
    description: "<p>A classic tee.</p>",
    images: ["https://img/6.png"],
  },
  { id: 68, title: "Ceramic Mug 11oz", brand: "Generic", model: "Mug", description: "White glossy mug.", images: [] },
  { id: 282, title: "Matte Vertical Posters", brand: "Generic", model: "Poster", description: "Museum-grade poster.", images: [] },
];
const PROVIDERS = [
  { id: 29, title: "Monster Digital" },
  { id: 99, title: "Printify Choice" },
];
const VARIANTS = {
  id: 29,
  title: "Monster Digital",
  variants: [
    { id: 12100, title: "White / S", options: { color: "White", size: "S" } },
    { id: 12101, title: "White / M", options: { color: "White", size: "M" } },
    { id: 12102, title: "Black / S", options: { color: "Black", size: "S" } },
    { id: 12103, title: "Black / M", options: { color: "Black", size: "M" } },
  ],
};
const SHOPS = [{ id: 5001, title: "Ama Prints", sales_channel: "etsy" }];
const PRODUCT_ID = "5d39b411749d0a000f30e0f4";
const ORDERS = {
  current_page: 1,
  data: [
    {
      id: "5a96f649b2439217d070f507",
      status: "fulfilled",
      created_at: "2026-10-20 13:24:28+00:00",
      line_items: [
        {
          product_id: PRODUCT_ID,
          quantity: 2,
          cost: 900,
          shipping_cost: 400,
          status: "fulfilled",
          metadata: { title: "Tee", price: 2499 },
        },
      ],
    },
    {
      id: "5a96f649b2439217d070f508",
      status: "in-production",
      created_at: "2026-10-25 09:00:00+00:00",
      line_items: [
        { product_id: PRODUCT_ID, quantity: 1, cost: 900, shipping_cost: 400, status: "in-production", metadata: { price: 2499 } },
      ],
    },
    {
      id: "5a96f649b2439217d070f509",
      status: "canceled",
      line_items: [{ product_id: PRODUCT_ID, quantity: 1, cost: 900, shipping_cost: 400, status: "canceled", metadata: { price: 2499 } }],
    },
  ],
};

type Call = { url: string; method: string; body?: Rec; auth?: string };

function server(calls: Call[] = [], opts: { channel?: string } = {}) {
  const products = new Map<string, Rec>();
  return fixtureFetch((url, init) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Rec) : undefined;
    calls.push({ url, method, ...(body ? { body } : {}), ...(headers.authorization ? { auth: headers.authorization } : {}) });
    if (headers.authorization !== "Bearer pt_test") return jsonResponse({ error: "Unauthenticated." }, 401);
    const at = url.replace("https://api.printify.com/v1", "");
    if (at === "/catalog/blueprints.json") return BLUEPRINTS;
    const bp = /^\/catalog\/blueprints\/(\d+)\.json$/u.exec(at);
    if (bp) return BLUEPRINTS.find((b) => String(b.id) === bp[1]) ?? jsonResponse({ error: "Not found" }, 404);
    if (/^\/catalog\/blueprints\/\d+\/print_providers\.json$/u.test(at)) return PROVIDERS;
    if (/^\/catalog\/blueprints\/\d+\/print_providers\/29\/variants\.json$/u.test(at)) return VARIANTS;
    if (at === "/shops.json") return SHOPS.map((s) => ({ ...s, sales_channel: opts.channel ?? s.sales_channel }));
    if (at === "/uploads/images.json" && method === "POST")
      return { id: "img-1", file_name: body?.file_name, preview_url: "https://images.printify.com/img-1", mime_type: "image/png" };
    if (/^\/uploads\/[^/]+\/archive\.json$/u.test(at)) return {};
    if (at === "/shops/5001/products.json" && method === "POST") {
      const p = { id: PRODUCT_ID, ...body, visible: false, is_locked: false, created_at: "2026-10-29 10:00:00+00:00" };
      products.set(PRODUCT_ID, p);
      return p;
    }
    if (at === `/shops/5001/products/${PRODUCT_ID}/publish.json`) {
      const p = products.get(PRODUCT_ID)!;
      products.set(PRODUCT_ID, {
        ...p,
        is_locked: false,
        visible: true,
        external: { id: "1234567", handle: "https://www.etsy.com/listing/1234567" },
      });
      return {};
    }
    if (at === `/shops/5001/products/${PRODUCT_ID}.json`) return products.get(PRODUCT_ID) ?? jsonResponse({ error: "Not found" }, 404);
    if (at.startsWith("/shops/5001/products.json")) return { current_page: 1, data: [...products.values()] };
    if (at.startsWith("/shops/5001/orders.json")) return at.includes("page=1") ? ORDERS : { current_page: 2, data: [] };
    return jsonResponse({ error: `unexpected ${method} ${at}` }, 500);
  });
}

const CREDS = { PRINTIFY_API_TOKEN: "pt_test" };
const fresh = () => createPrintify({ stateDir: mkdtempSync(path.join(os.tmpdir(), "printify-")) });

describeConnectorConformance(printify, { search: { query: "mug" }, fetch: server(), credentials: CREDS, expectQueryInUrl: false });

describe("printify", () => {
  it("lists blueprints as tasks and filters them by the words", async () => {
    const ctx = testContext({ fetch: server(), credentials: CREDS });
    const all = await printify.search!({}, ctx);
    expect(all.jobs.map((j) => j.id)).toEqual(["bp-6", "bp-68", "bp-282"]);
    expect(all.jobs[0]).toMatchObject({ title: "Sell your design on: Unisex Heavy Cotton Tee", org: "Gildan", summary: "A classic tee." });
    for (const job of all.jobs) expect(NativeJobSchema.safeParse(job).success).toBe(true);
    expect((await printify.search!({ query: "poster" }, ctx)).jobs.map((j) => j.id)).toEqual(["bp-282"]);
    await expect(printify.search!({}, testContext({ fetch: server() }))).rejects.toMatchObject({ code: "auth_required" });
  });

  it("reads a blueprint with its print providers", async () => {
    const job = await printify.get!("bp-6", testContext({ fetch: server(), credentials: CREDS }));
    expect(job!.description).toContain("Print providers (print_provider_id): 29 Monster Digital; 99 Printify Choice.");
    expect(await printify.get!("bp-999", testContext({ fetch: server(), credentials: CREDS }))).toBeNull();
    expect(await printify.get!("nope", testContext({ fetch: server(), credentials: CREDS }))).toBeNull();
  });

  it("drafts, uploads the design, needs the confirmation, then creates and publishes", async () => {
    const connector = fresh();
    const calls: Call[] = [];
    const ctx = testContext({ fetch: server(calls), credentials: CREDS });
    await expect(connector.apply!("bp-6", { answers: { price: "24.99" } }, ctx)).rejects.toMatchObject({ code: "invalid_input" });
    const started = await connector.apply!("bp-6", { answers: { title: "Sunset tee", colors: "White" } }, ctx);
    expect(NativeApplicationSchema.safeParse(started).success).toBe(true);
    expect(started).toMatchObject({ job_id: "bp-6", stage: "work_needed", progress: { received: 1, wanted: 3, ready_to_submit: false } });
    expect(started.next).toContain("price");
    const id = started.id;

    await connector.apply!(id, { answers: { price: "$24.99", tags: "sunset, beach, sunset" } }, ctx);
    const receipt = await connector.upload!(
      id,
      { kind: "file", name: "sunset.png", mime_type: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) },
      ctx,
    );
    expect(WorkReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(receipt.file).toMatchObject({ id: "img-1", name: "sunset.png", kind: "image", size: 4 });
    expect(calls.find((c) => c.url.endsWith("/uploads/images.json"))!.body).toEqual({ file_name: "sunset.png", contents: "iVBORw==" });
    expect(receipt.progress).toEqual({ received: 3, wanted: 3, ready_to_submit: true });

    const ready = await connector.status!(id, ctx);
    const token = (ready!.raw as Rec).confirm as string;
    expect(ready!.next).toContain(`confirm:${token}`);
    await expect(connector.submit!(id, {}, ctx)).rejects.toMatchObject({ code: "invalid_input", details: { confirm_required: true } });
    await expect(connector.submit!(id, { note: "confirm:000000000000" }, ctx)).rejects.toMatchObject({ code: "invalid_input" });

    const sent = await connector.submit!(id, { note: `confirm:${token}` }, ctx);
    expect(sent).toMatchObject({ id, stage: "in_review" });
    expect(sent.next).toContain("Created and sent to etsy with 2 variants at 24.99");
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/shops/5001/products.json"))!;
    expect(create.body).toEqual({
      title: "Sunset tee",
      description: "",
      tags: ["sunset", "beach"],
      blueprint_id: 6,
      print_provider_id: 29,
      variants: [
        { id: 12100, price: 2499, is_enabled: true },
        { id: 12101, price: 2499, is_enabled: true },
      ],
      print_areas: [
        {
          variant_ids: [12100, 12101],
          placeholders: [{ position: "front", images: [{ id: "img-1", x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
        },
      ],
    });
    expect(calls.some((c) => c.url.endsWith(`/products/${PRODUCT_ID}/publish.json`))).toBe(true);
    await expect(connector.apply!(id, { answers: { price: "30" } }, ctx)).rejects.toMatchObject({ code: "wrong_stage" });

    const live = await connector.status!(id, ctx);
    expect(live).toMatchObject({
      id,
      stage: "accepted",
      url: "https://www.etsy.com/listing/1234567",
      review: { earned: { amount: 39.97, currency: "USD" } },
    });
    expect(live!.next).toContain("3 items sold in 2 orders");

    const mine = await connector.list!(ctx);
    expect(mine.map((a) => [a.id, a.stage])).toEqual([[id, "accepted"]]);
  });

  it("creates without publishing when the shop has no sales channel", async () => {
    const connector = fresh();
    const ctx = testContext({ fetch: server([], { channel: "disconnected" }), credentials: CREDS });
    const d = await connector.apply!("bp-6", { answers: { title: "Tee", price: "20" } }, ctx);
    await connector.upload!(d.id, { kind: "text", text: "Design: https://cdn.example.com/art/tee.png." }, ctx);
    const token = ((await connector.status!(d.id, ctx))!.raw as Rec).confirm as string;
    const out = await connector.submit!(d.id, { note: `confirm:${token}` }, ctx);
    expect(out.next).toContain("no sales channel to publish to (disconnected)");
  });

  it("removes the design and refuses a non-image", async () => {
    const connector = fresh();
    const ctx = testContext({ fetch: server(), credentials: CREDS });
    const d = await connector.apply!("bp-68", { answers: { title: "Mug" } }, ctx);
    await expect(
      connector.upload!(d.id, { kind: "file", name: "a.pdf", mime_type: "application/pdf", bytes: new Uint8Array([1]) }, ctx),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await connector.upload!(d.id, { kind: "file", name: "m.png", mime_type: "image/png", bytes: new Uint8Array([1]) }, ctx);
    const gone = await connector.remove!(d.id, "img-1", ctx);
    expect(gone).toMatchObject({ removed: { id: "img-1", name: "m.png" }, files: [] });
    await expect(connector.remove!(d.id, "img-1", ctx)).rejects.toMatchObject({ code: "not_found" });
  });

  it("reads earnings from orders: retail less Printify's cost, canceled left out", async () => {
    const earned = await printify.earnings!(testContext({ fetch: server(), credentials: CREDS }));
    expect(NativeEarningsSchema.safeParse(earned).success).toBe(true);
    expect(earned).toMatchObject({
      balance: { amount: 27.98, currency: "USD" },
      pending: { amount: 11.99, currency: "USD" },
      total_earned: { amount: 39.97, currency: "USD" },
    });
    expect(earned.entries!.map((e) => [e.status, e.earned_at])).toEqual([
      ["available", "2026-10-20T13:24:28.000Z"],
      ["pending", "2026-10-25T09:00:00.000Z"],
    ]);
  });

  it("reports the account and the shop it sells in", async () => {
    expect(await printify.account!(testContext({ fetch: server(), credentials: CREDS }))).toMatchObject({
      signed_in: true,
      label: "Ama Prints",
      ready: true,
      profile: { shop_id: 5001, sales_channel: "etsy" },
    });
    expect(await printify.account!(testContext({ fetch: server() }))).toMatchObject({ signed_in: false });
    expect(await printify.account!(testContext({ fetch: server(), credentials: { ...CREDS, PRINTIFY_SHOP_ID: "42" } }))).toMatchObject({
      ready: false,
    });
  });

  it("parses answers and picks variants", () => {
    expect(parseAnswers({ price: "12", position: "Back", print_provider_id: "29" })).toEqual({
      price: 1200,
      position: "back",
      provider: 29,
    });
    expect(() => parseAnswers({ price: "-1", colour: "red", position: "side" })).toThrow(/price.*colour.*position/u);
    expect(pickVariants(VARIANTS.variants, ["black"], ["m"]).map((v) => v.id)).toEqual([12103]);
    expect(blueprintToJob({ title: "no id" })).toBeNull();
    expect(ordersFor(ORDERS.data, "other")).toEqual([]);
  });
});
