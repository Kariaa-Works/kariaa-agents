/**
 * Printify through its REST API (https://developers.printify.com/, https://api.printify.com/v1): the person sells
 * print-on-demand products in a shop connected to Printify (Etsy, Shopify, eBay, TikTok Shop, WooCommerce…).
 * search lists the catalog's blueprints (the things a design can go on: shirts, mugs, posters); apply starts a
 * product draft for one, kept here until it is complete; upload sends the design to Printify's media library;
 * submit, once the person confirms with the draft's token, creates the product in the shop and asks Printify to
 * publish it to the connected sales channel. status and list follow products and their orders, and earnings
 * reads orders: the retail price the buyer paid less what Printify charges to make and ship it. The sales
 * channel collects the money and pays it out, so there is no payout here.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConnector, type ConnectorContext } from "../../core/connector.js";
import { ProtocolError } from "../../core/errors.js";
import { fetchJson } from "../../core/http.js";
import { applyFilters, iso, num, str, strings } from "../../core/jsonBoard.js";
import { perTenant, stateDir } from "../../core/tenant.js";
import { stripHtml } from "../../core/text.js";
import type {
  Account,
  ApplyInput,
  Earning,
  NativeApplication,
  NativeEarnings,
  NativeJob,
  Question,
  WorkReceipt,
} from "../../core/types.js";

export const PRINTIFY_API = "https://api.printify.com/v1";
const ID = "printify";
const LABEL = "Printify";
const TOKEN_ENV = "PRINTIFY_API_TOKEN";
const SHOP_ENV = "PRINTIFY_SHOP_ID";
export const PRINTIFY_HELP =
  "Set PRINTIFY_API_TOKEN to a personal access token from https://printify.com/app/account/api (scopes: shops.read, catalog.read, products.read, products.write, uploads.read, uploads.write, orders.read). With more than one shop, PRINTIFY_SHOP_ID picks the one to sell in; otherwise the first shop is used.";

/** Etsy allows 100 variants on a listing; Printify products are kept to the same. */
const MAX_VARIANTS = 100;
const ORDER_PAGES = 5;
const BLUEPRINT = /^bp-(\d+)$/u;
const DRAFT = /^d-[a-f0-9]{12}$/u;
const PRODUCT = /^p-([a-f0-9]{24})$/u;
/** Sales channels that Printify's publish call actually lists on. A custom or disconnected shop only gets the product. */
const PUBLISHING_CHANNELS = new Set([
  "etsy",
  "shopify",
  "ebay",
  "woocommerce",
  "tiktok",
  "bigcommerce",
  "wix",
  "squarespace",
  "prestashop",
]);

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);
const recs = (value: unknown): Rec[] => (Array.isArray(value) ? value.map(rec).filter((r): r is Rec => Boolean(r)) : []);
const cents = (n: number) => (n / 100).toFixed(2);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fail = (code: ConstructorParameters<typeof ProtocolError>[0], message: string, details?: Rec) =>
  new ProtocolError(code, message, { connector: ID, ...(details ? { details } : {}) });

// ---- product fields ------------------------------------------------------------------------

type Field = { name: string; question: string; required?: boolean };

/** The answers apply takes. */
export const FIELDS: readonly Field[] = [
  { name: "title", question: "Product title", required: true },
  { name: "price", question: "Retail price per item in the shop's currency, such as 24.99", required: true },
  { name: "description", question: "Description buyers read" },
  { name: "tags", question: "Tags, comma separated" },
  { name: "print_provider_id", question: "Print provider id (from get on the blueprint); the first one is used when left out" },
  { name: "colors", question: "Colors to offer, comma separated, such as White, Black; all when left out" },
  { name: "sizes", question: "Sizes to offer, comma separated, such as S, M, L; all when left out" },
  { name: "position", question: "Where the design goes: front (default) or back" },
];
const FIELD = new Map(FIELDS.map((f) => [f.name, f]));

const questions = (): Question[] =>
  FIELDS.map((f) => ({ id: f.name, question: f.question, type: "text" as const, required: Boolean(f.required) }));

const list = (text: string) => [
  ...new Set(
    text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

type Changes = Partial<Pick<Draft, "title" | "price" | "description" | "tags" | "provider" | "colors" | "sizes" | "position">>;

/** Answers as draft fields, every bad one reported at once. */
export function parseAnswers(answers: ApplyInput["answers"] = {}): Changes {
  const errors: string[] = [];
  const out: Changes = {};
  for (const [name, raw] of Object.entries(answers)) {
    if (!FIELD.has(name)) {
      errors.push(`${name} is not a field this connector sets (it takes ${FIELDS.map((f) => f.name).join(", ")})`);
      continue;
    }
    const text = (Array.isArray(raw) ? raw.join(",") : raw).trim();
    if (name === "price") {
      const plain = text.replace(/^[$€£]\s*/u, "");
      if (!/^\d+(?:\.\d{1,2})?$/u.test(plain) || Number(plain) <= 0) errors.push("price is a positive amount such as 24.99");
      else out.price = Math.round(Number(plain) * 100);
    } else if (name === "title") {
      if (!text) errors.push("title cannot be empty");
      else if (text.length > 255) errors.push("title takes up to 255 characters");
      else out.title = text;
    } else if (name === "description") out.description = text;
    else if (name === "tags") out.tags = list(text).slice(0, 13);
    else if (name === "print_provider_id") {
      if (!/^\d+$/u.test(text)) errors.push("print_provider_id is a number from get on the blueprint");
      else out.provider = Number(text);
    } else if (name === "colors") out.colors = list(text);
    else if (name === "sizes") out.sizes = list(text);
    else if (name === "position") {
      const where = text.toLowerCase();
      if (where !== "front" && where !== "back") errors.push("position is front or back");
      else out.position = where;
    }
  }
  if (errors.length) throw fail("invalid_input", `Fix these answers: ${errors.join("; ")}.`, { errors });
  return out;
}

// ---- drafts ------------------------------------------------------------------------------------

type Design = { id: string; name: string; size?: number; preview?: string };

type Draft = {
  key: string;
  blueprint: number;
  blueprint_title: string;
  title?: string;
  price?: number;
  description?: string;
  tags?: string[];
  provider?: number;
  colors?: string[];
  sizes?: string[];
  position?: string;
  design?: Design;
  /** Set once submit created the product in the shop. */
  product_id?: string;
  shop_id?: number;
  created_at: string;
  updated_at: string;
};

type State = { drafts: Record<string, Draft> };

/** Drafts in printify-drafts.json, so a later process can submit them. The design itself lives in Printify's library. */
class Drafts {
  private memory: State | undefined;
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "printify-drafts.json");
  }

  private load(): State {
    if (this.memory) return this.memory;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<State>;
      this.memory = { drafts: parsed.drafts ?? {} };
    } catch {
      this.memory = { drafts: {} };
    }
    return this.memory;
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.load(), null, 2));
    } catch {
      // memory still holds it for this process
    }
  }

  get(key: string): Draft | undefined {
    return this.load().drafts[key];
  }

  all(): Draft[] {
    return Object.values(this.load().drafts);
  }

  set(draft: Draft): void {
    this.load().drafts[draft.key] = draft;
    this.save();
  }
}

/** What a draft still needs before it can be submitted. */
function missingOf(d: Draft): string[] {
  return [...(d.title ? [] : ["title"]), ...(d.price ? [] : ["price"]), ...(d.design ? [] : ["a design (upload an image)"])];
}

/** What submitting would put on sale, hashed: the token changes whenever the draft does. */
export function confirmToken(d: Draft): string {
  const content = JSON.stringify([d.key, d.updated_at, d.title ?? null, d.price ?? null, d.design?.id ?? null, d.provider ?? null]);
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

const filesOf = (d: Draft) =>
  d.design ? [{ id: d.design.id, name: d.design.name, kind: "image", ...(d.design.size ? { size: d.design.size } : {}) }] : [];

function progressOf(d: Draft) {
  const missing = missingOf(d);
  return { received: 3 - missing.length, wanted: 3, ready_to_submit: missing.length === 0 };
}

function draftNext(d: Draft): string {
  const missing = missingOf(d);
  if (missing.length) return `Still needed on ${d.key}: ${missing.join(", ")}.`;
  return `Ready. Nothing is public yet. Show the person: "${d.title}" on ${d.blueprint_title} at ${cents(d.price!)} per item, design ${d.design!.name}${d.design!.preview ? ` (${d.design!.preview})` : ""}. Then submit with note "confirm:${confirmToken(d)}" to create it in the shop and publish it.`;
}

function draftApplication(d: Draft): NativeApplication {
  const files = filesOf(d);
  const progress = progressOf(d);
  return {
    id: d.key,
    job_id: `bp-${d.blueprint}`,
    job_title: d.title ?? d.blueprint_title,
    stage: "work_needed",
    ...(files.length ? { files } : {}),
    progress,
    next: draftNext(d),
    created_at: d.created_at,
    updated_at: d.updated_at,
    raw: { blueprint_id: d.blueprint, missing: missingOf(d), ...(progress.ready_to_submit ? { confirm: confirmToken(d) } : {}) },
  };
}

// ---- mapping -----------------------------------------------------------------------------------

/** One catalog blueprint as a task: something the person can put a design on and sell. */
export function blueprintToJob(b: Rec): NativeJob | null {
  const id = num(b.id);
  const title = str(b.title);
  if (id === undefined || !title) return null;
  const brand = str(b.brand);
  const model = str(b.model);
  const description = str(b.description);
  return {
    id: `bp-${id}`,
    kind: "task",
    title: `Sell your design on: ${title}`,
    ...(brand ? { org: brand } : {}),
    ...(description ? { summary: stripHtml(description, 300), description: stripHtml(description, 6000) } : {}),
    location: { remote: true, text: "Online" },
    url: `https://printify.com/app/products/${id}`,
    tags: ["print-on-demand", ...(brand ? [brand] : []), ...(model ? [model] : []), "source:printify"],
    participation_mode: "direct_apply",
    apply_hint:
      "apply with title and price starts a draft for this product; upload adds the design image; submit with the confirmation it returns creates the product in your shop and publishes it to the connected sales channel.",
    requirements: {
      questions: questions(),
      files: { kinds: ["image"], count: 1 },
      how_to: [
        `apply("bp-${id}") with at least a title; it returns the draft's id and what is still missing.`,
        "apply to that id again to fill the rest; upload the design image to it (a PNG with a transparent background prints best).",
        'Show the person the preview, then submit with note "confirm:<token>" to put it on sale.',
      ],
      rules: ["One design per product, placed centered on the front or the back", `Up to ${MAX_VARIANTS} variants, all at one price`],
    },
    raw: { blueprint_id: id, images: strings(b.images).slice(0, 3) },
  };
}

type Order = {
  id: string;
  status: string;
  retail: number;
  cost: number;
  quantity: number;
  created_at?: string;
};

const LIVE_ORDER = (status: string) => !["canceled", "unfulfillable", "payment-not-received"].includes(status);

/** The lines of each order that belong to a product (or all lines), with retail and Printify's cost in cents. */
export function ordersFor(orders: Rec[], productId?: string): Order[] {
  const out: Order[] = [];
  for (const o of orders) {
    const lines = recs(o.line_items).filter((l) => !productId || str(l.product_id) === productId);
    if (!lines.length) continue;
    let retail = 0;
    let cost = 0;
    let quantity = 0;
    for (const l of lines) {
      if (str(l.status) === "canceled") continue;
      const q = num(l.quantity) ?? 1;
      quantity += q;
      retail += (num(rec(l.metadata)?.price) ?? 0) * q;
      cost += (num(l.cost) ?? 0) * q + (num(l.shipping_cost) ?? 0);
    }
    const created = iso(o.created_at);
    out.push({
      id: String(o.id ?? ""),
      status: str(o.status) ?? "pending",
      retail,
      cost,
      quantity,
      ...(created ? { created_at: created } : {}),
    });
  }
  return out;
}

const productUrl = (p: Rec) => str(rec(p.external)?.handle);

/** A product in the shop as an application: published, publishing, or created but not on sale; with its orders. */
export function productApplication(p: Rec, orders: Rec[] = [], key?: string): NativeApplication {
  const id = str(p.id) ?? "";
  const title = str(p.title);
  const url = productUrl(p);
  const published = Boolean(str(rec(p.external)?.id));
  const locked = p.is_locked === true;
  const sold = ordersFor(orders, id).filter((o) => LIVE_ORDER(o.status));
  const profit = sold.reduce((t, o) => t + o.retail - o.cost, 0);
  const items = sold.reduce((t, o) => t + o.quantity, 0);
  const created = iso(p.created_at);
  const updated = iso(p.updated_at);
  const sales = sold.length
    ? ` ${plural(items, "item")} sold in ${plural(sold.length, "order")}, ${cents(profit)} after Printify's costs.`
    : "";
  return {
    id: key ?? `p-${id}`,
    job_id: num(p.blueprint_id) !== undefined ? `bp-${num(p.blueprint_id)}` : `p-${id}`,
    ...(title ? { job_title: title } : {}),
    stage: sold.length ? "accepted" : published ? "applied" : locked ? "in_review" : "work_needed",
    next: published
      ? `On sale${url ? ` at ${url}` : ""}.${sales || " No orders yet."}`
      : locked
        ? `Publishing to the sales channel; Printify locks the product until the channel confirms.${sales}`
        : `In the Printify shop but not published to a sales channel. Publish it from Printify, or connect the shop to a channel.${sales}`,
    ...(url ? { url } : {}),
    ...(created ? { created_at: created } : {}),
    ...(updated ? { updated_at: updated } : {}),
    ...(sold.length ? { review: { earned: { amount: Math.round(profit) / 100, currency: "USD" } } } : {}),
    raw: { product_id: id, visible: p.visible ?? null, locked, external: p.external ?? null, orders: sold },
  };
}

/** Variants of one print provider, narrowed to the asked colors and sizes, at most MAX_VARIANTS. */
export function pickVariants(variants: Rec[], colors: string[] = [], sizes: string[] = []): Rec[] {
  const wants = (asked: string[], value: string | undefined) =>
    !asked.length || (value !== undefined && asked.some((a) => a.toLowerCase() === value.toLowerCase()));
  return variants
    .filter((v) => {
      const options = rec(v.options);
      return wants(colors, str(options?.color)) && wants(sizes, str(options?.size));
    })
    .slice(0, MAX_VARIANTS);
}

// ---- the connector -------------------------------------------------------------------------------

export type PrintifyOptions = {
  /** Where drafts are kept. Default: the work-protocol cache folder (per tenant when hosted). */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export function createPrintify(options: PrintifyOptions = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const drafts = perTenant(() => new Drafts(options.stateDir ?? stateDir(env)));

  function tokenOf(ctx: ConnectorContext): string {
    const token = ctx.credentials[TOKEN_ENV]?.trim();
    if (!token) throw fail("auth_required", PRINTIFY_HELP);
    return token;
  }

  async function api<T = unknown>(ctx: ConnectorContext, target: string, label: string, body?: unknown): Promise<T> {
    return fetchJson<T>(ctx, `${PRINTIFY_API}${target}`, {
      label: LABEL,
      connector: ID,
      headers: { authorization: `Bearer ${tokenOf(ctx)}` },
      ...(body === undefined ? {} : { method: "POST" as const, body }),
      authHelp: PRINTIFY_HELP,
    }).catch((error: unknown) => {
      if (error instanceof ProtocolError && error.code === "not_found") throw fail("not_found", `${LABEL} has no ${label}.`);
      throw error;
    });
  }

  async function shops(ctx: ConnectorContext): Promise<Rec[]> {
    return recs(await api(ctx, "/shops.json", "shops"));
  }

  /** PRINTIFY_SHOP_ID, else the first shop. */
  async function shop(ctx: ConnectorContext): Promise<Rec> {
    const all = await shops(ctx);
    const wanted = ctx.credentials[SHOP_ENV]?.trim();
    const found = wanted ? all.find((s) => String(s.id) === wanted) : all[0];
    if (!found) {
      throw fail(
        "not_ready",
        wanted
          ? `No Printify shop ${wanted} on this account (it has ${all.map((s) => `${String(s.id)} ${str(s.title) ?? ""}`.trim()).join(", ") || "none"}).`
          : "This Printify account has no shop yet: connect Etsy, Shopify or another sales channel in Printify first.",
      );
    }
    return found;
  }

  async function productOf(ctx: ConnectorContext, shopId: number, productId: string): Promise<Rec> {
    const p = rec(await api(ctx, `/shops/${shopId}/products/${productId}.json`, `product ${productId}`));
    if (!p) throw fail("not_found", `${LABEL} has no product ${productId}.`);
    return p;
  }

  async function recentOrders(ctx: ConnectorContext, shopId: number): Promise<Rec[]> {
    const out: Rec[] = [];
    for (let page = 1; page <= ORDER_PAGES; page++) {
      const body = rec(await api(ctx, `/shops/${shopId}/orders.json?limit=10&page=${page}`, "orders"));
      const rows = recs(body?.data);
      out.push(...rows);
      const last = num(body?.last_page);
      if (rows.length < 10 || (last !== undefined && page >= last)) break;
    }
    return out;
  }

  async function blueprint(ctx: ConnectorContext, id: number): Promise<Rec> {
    const b = rec(await api(ctx, `/catalog/blueprints/${id}.json`, `blueprint ${id}`));
    if (!b) throw fail("not_found", `${LABEL} has no blueprint ${id}.`);
    return b;
  }

  async function providers(ctx: ConnectorContext, id: number): Promise<Rec[]> {
    return recs(await api(ctx, `/catalog/blueprints/${id}/print_providers.json`, `print providers for blueprint ${id}`));
  }

  function draftOf(key: string): Draft {
    const d = drafts().get(key);
    if (!d) throw fail("not_found", `No Printify draft ${key} here. Drafts are kept by the process that started them.`);
    return d;
  }

  function open(key: string): Draft {
    const d = draftOf(key);
    if (d.product_id) {
      throw fail("wrong_stage", "This draft was already submitted; change the product in Printify.", { stage: "applied" });
    }
    return d;
  }

  const touch = (d: Draft): Draft => ({ ...d, updated_at: now().toISOString() });

  return defineConnector({
    id: ID,
    name: LABEL,
    description:
      "Sell print-on-demand products through Printify: browse the catalog (shirts, mugs, posters…), start a product with a design, and on your confirmation create it in your shop and publish it to the connected sales channel (Etsy, Shopify, eBay, TikTok Shop…). Follows products and orders and reads profit after Printify's costs. Needs a Printify personal access token.",
    homepage: "https://printify.com",
    kinds: ["task"],
    category: "selling",
    payoutRails: ["fiat"],
    auth: { type: "api_key", env: [TOKEN_ENV, SHOP_ENV], anyOf: [[TOKEN_ENV]], help: PRINTIFY_HELP, required: true },

    async search(q, ctx) {
      const limit = q.limit ?? 25;
      const words = (q.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
      const rows = recs(await api(ctx, "/catalog/blueprints.json", "catalog"));
      const hits = rows.filter((b) => {
        if (!words.length) return true;
        const text = [b.title, b.brand, b.model, b.description]
          .map((v) => str(v) ?? "")
          .join(" ")
          .toLowerCase();
        return words.every((w) => text.includes(w));
      });
      const jobs = hits.map(blueprintToJob).filter((j): j is NativeJob => j !== null);
      const filtered = applyFilters(jobs, { ...q, query: undefined }, { query: false, location: true, remote: true });
      return { jobs: filtered.slice(0, limit), more: filtered.length > limit };
    },

    async get(nativeId, ctx) {
      const match = BLUEPRINT.exec(nativeId);
      if (!match) return null;
      const id = Number(match[1]);
      let b: Rec;
      try {
        b = await blueprint(ctx, id);
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "not_found") return null;
        throw error;
      }
      const job = blueprintToJob(b);
      if (!job) return null;
      const made = await providers(ctx, id);
      const names = made.map((p) => `${String(p.id)} ${str(p.title) ?? ""}`.trim());
      return {
        ...job,
        ...(names.length
          ? { description: `${job.description ? `${job.description}\n\n` : ""}Print providers (print_provider_id): ${names.join("; ")}.` }
          : {}),
        raw: { ...rec(job.raw), print_providers: made.map((p) => ({ id: p.id ?? null, title: p.title ?? null })) },
      };
    },

    async apply(nativeId, input, ctx) {
      tokenOf(ctx);
      const changes = parseAnswers(input.answers);
      const match = BLUEPRINT.exec(nativeId);
      if (match) {
        if (!changes.title) throw fail("invalid_input", "A new product needs at least a title.", { missing: ["title"] });
        const id = Number(match[1]);
        const b = await blueprint(ctx, id);
        const made = await providers(ctx, id);
        if (changes.provider !== undefined && !made.some((p) => num(p.id) === changes.provider)) {
          throw fail(
            "invalid_input",
            `Print provider ${changes.provider} does not make blueprint ${id}; get bp-${id} lists the ones that do.`,
          );
        }
        const at = now().toISOString();
        const d: Draft = {
          key: `d-${randomUUID().replace(/-/gu, "").slice(0, 12)}`,
          blueprint: id,
          blueprint_title: str(b.title) ?? `blueprint ${id}`,
          ...changes,
          created_at: at,
          updated_at: at,
        };
        drafts().set(d);
        return draftApplication(d);
      }
      if (!DRAFT.test(nativeId)) throw fail("not_found", `${JSON.stringify(nativeId)} is not a blueprint (bp-…) or a draft (d-…).`);
      const d = touch({ ...open(nativeId), ...changes });
      drafts().set(d);
      return draftApplication(d);
    },

    async upload(nativeApplicationId, work, ctx): Promise<WorkReceipt> {
      const d = open(nativeApplicationId);
      let body: Rec;
      let name: string;
      let size: number | undefined;
      if (work.kind === "text") {
        const link = /https:\/\/\S+/u.exec(work.text)?.[0]?.replace(/[),.;]+$/u, "");
        if (!link) throw fail("invalid_input", "Send the design as an image file, or an https link to the image.");
        name = decodeURIComponent(link.split("/").pop()?.split("?")[0] || "design.png");
        body = { file_name: name, url: link };
      } else {
        if (!work.mime_type.toLowerCase().startsWith("image/"))
          throw fail("invalid_input", `The design is an image; ${work.name} is ${work.mime_type}.`);
        name = work.name;
        size = work.bytes.byteLength;
        body = { file_name: name, contents: Buffer.from(work.bytes).toString("base64") };
      }
      const image = rec(await api(ctx, "/uploads/images.json", "the upload", body));
      const imageId = str(image?.id);
      if (!imageId) throw fail("upstream_error", `${LABEL} took the upload without returning an image id.`);
      const preview = str(image?.preview_url);
      const next = touch({
        ...d,
        design: { id: imageId, name: str(image?.file_name) ?? name, ...(size ? { size } : {}), ...(preview ? { preview } : {}) },
      });
      drafts().set(next);
      return { file: filesOf(next)[0]!, files: filesOf(next), progress: progressOf(next), next: draftNext(next) };
    },

    async remove(nativeApplicationId, fileId, ctx): Promise<WorkReceipt> {
      const d = open(nativeApplicationId);
      if (!d.design || d.design.id !== fileId) throw fail("not_found", `${JSON.stringify(fileId)} is not the design on this draft.`);
      await api(ctx, `/uploads/${fileId}/archive.json`, "the upload", {}).catch(() => undefined);
      const { design, ...rest } = d;
      const next = touch(rest);
      drafts().set(next);
      return { removed: { id: design.id, name: design.name }, files: [], progress: progressOf(next), next: draftNext(next) };
    },

    async submit(nativeApplicationId, input, ctx) {
      const product = PRODUCT.exec(nativeApplicationId);
      if (product) {
        const s = await shop(ctx);
        return productApplication(await productOf(ctx, Number(s.id), product[1]!), [], nativeApplicationId);
      }
      const d = draftOf(nativeApplicationId);
      if (d.product_id && d.shop_id !== undefined) {
        return productApplication(await productOf(ctx, d.shop_id, d.product_id), [], d.key);
      }
      const missing = missingOf(d);
      if (missing.length) throw fail("not_ready", draftNext(d), { missing });
      const note = input.note?.trim() ?? "";
      if (note !== `confirm:${confirmToken(d)}`) {
        throw fail(
          "invalid_input",
          note.toLowerCase().startsWith("confirm:")
            ? 'That confirmation does not match the draft as it stands now. Read it again with status, show the person the preview, and submit with the note "confirm:<token>" it gives.'
            : `Submitting puts the product on sale in the person's shop. Show them the preview from apply or status first, then submit with the note "confirm:<token>" it gives.`,
          { confirm_required: true },
        );
      }
      const s = await shop(ctx);
      const shopId = Number(s.id);
      const made = await providers(ctx, d.blueprint);
      const provider = d.provider ?? num(made[0]?.id);
      if (provider === undefined) throw fail("not_ready", `No print provider makes ${d.blueprint_title} right now.`);
      const catalog = rec(
        await api(
          ctx,
          `/catalog/blueprints/${d.blueprint}/print_providers/${provider}/variants.json`,
          `variants from provider ${provider}`,
        ),
      );
      const variants = pickVariants(recs(catalog?.variants), d.colors, d.sizes);
      if (!variants.length) {
        throw fail("invalid_input", `No variant of ${d.blueprint_title} from provider ${provider} matches the colors and sizes asked for.`);
      }
      const ids = variants.map((v) => num(v.id)).filter((n): n is number => n !== undefined);
      const created = rec(
        await api(ctx, `/shops/${shopId}/products.json`, "the product", {
          title: d.title,
          description: d.description ?? "",
          ...(d.tags?.length ? { tags: d.tags } : {}),
          blueprint_id: d.blueprint,
          print_provider_id: provider,
          variants: ids.map((id) => ({ id, price: d.price, is_enabled: true })),
          print_areas: [
            {
              variant_ids: ids,
              placeholders: [{ position: d.position ?? "front", images: [{ id: d.design!.id, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
            },
          ],
        }),
      );
      const productId = str(created?.id);
      if (!created || !productId) throw fail("upstream_error", `${LABEL} created the product without returning its id.`);
      drafts().set(touch({ ...d, product_id: productId, shop_id: shopId }));
      const channel = (str(s.sales_channel) ?? "").toLowerCase();
      if (!PUBLISHING_CHANNELS.has(channel)) {
        return {
          ...productApplication(created, [], d.key),
          next: `Created in the Printify shop "${str(s.title) ?? shopId}", which has no sales channel to publish to (${channel || "none"}). Connect the shop to Etsy, Shopify or another channel in Printify, then publish it there.`,
        };
      }
      await api(ctx, `/shops/${shopId}/products/${productId}/publish.json`, "publishing", {
        title: true,
        description: true,
        images: true,
        variants: true,
        tags: true,
      });
      return {
        ...productApplication({ ...created, is_locked: true }, [], d.key),
        stage: "in_review",
        next: `Created and sent to ${channel} with ${plural(ids.length, "variant")} at ${cents(d.price!)}. Printify locks it while ${channel} lists it; status shows when it is on sale and its orders.`,
      };
    },

    async status(nativeApplicationId, ctx) {
      const product = PRODUCT.exec(nativeApplicationId);
      if (!product && !DRAFT.test(nativeApplicationId)) return null;
      if (!product) {
        const d = drafts().get(nativeApplicationId);
        if (!d) return null;
        if (!d.product_id || d.shop_id === undefined) return draftApplication(d);
        const [p, orders] = await Promise.all([productOf(ctx, d.shop_id, d.product_id), recentOrders(ctx, d.shop_id)]);
        return productApplication(p, orders, d.key);
      }
      const s = await shop(ctx);
      try {
        const [p, orders] = await Promise.all([productOf(ctx, Number(s.id), product[1]!), recentOrders(ctx, Number(s.id))]);
        return productApplication(p, orders, nativeApplicationId);
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "not_found") return null;
        throw error;
      }
    },

    async list(ctx) {
      const s = await shop(ctx);
      const shopId = Number(s.id);
      const [body, orders] = await Promise.all([
        api(ctx, `/shops/${shopId}/products.json?limit=50`, "products"),
        recentOrders(ctx, shopId),
      ]);
      const products = recs(rec(body)?.data);
      const submitted = new Map(
        drafts()
          .all()
          .filter((d) => d.product_id)
          .map((d) => [d.product_id!, d.key]),
      );
      const pending = drafts()
        .all()
        .filter((d) => !d.product_id)
        .map(draftApplication);
      return [...pending, ...products.map((p) => productApplication(p, orders, submitted.get(str(p.id) ?? "")))];
    },

    async account(ctx): Promise<Account> {
      if (!ctx.credentials[TOKEN_ENV]?.trim()) return { signed_in: false, ready: false, missing: [TOKEN_ENV], help: PRINTIFY_HELP };
      const all = await shops(ctx);
      const wanted = ctx.credentials[SHOP_ENV]?.trim();
      const chosen = wanted ? all.find((s) => String(s.id) === wanted) : all[0];
      const channel = str(chosen?.sales_channel);
      return {
        signed_in: true,
        ...(str(chosen?.title) ? { label: str(chosen?.title) } : {}),
        ready: Boolean(chosen),
        ...(chosen ? {} : { missing: [wanted ? `the shop ${wanted} (${SHOP_ENV})` : "a shop connected to a sales channel in Printify"] }),
        profile: {
          shop_id: chosen?.id ?? null,
          shop: chosen?.title ?? null,
          sales_channel: channel ?? null,
          shops: all.map((s) => ({ id: s.id ?? null, title: s.title ?? null, sales_channel: s.sales_channel ?? null })),
        },
        help: `The sales channel${channel ? ` (${channel})` : ""} collects what buyers pay and pays it out; Printify charges the card or balance on the account for making and shipping each order. Products go on sale here only after the person confirms.`,
      };
    },

    async earnings(ctx): Promise<NativeEarnings> {
      const s = await shop(ctx);
      const orders = ordersFor(await recentOrders(ctx, Number(s.id))).filter((o) => LIVE_ORDER(o.status));
      const entries: Earning[] = orders.map((o) => ({
        id: o.id,
        job_title: `Order ${o.id}`,
        amount: Math.round(o.retail - o.cost) / 100,
        currency: "USD",
        status: o.status === "fulfilled" ? "available" : "pending",
        ...(o.created_at ? { earned_at: o.created_at } : {}),
        note: `${plural(o.quantity, "item")}: ${cents(o.retail)} retail less ${cents(o.cost)} Printify cost and shipping (${o.status})`,
      }));
      const sum = (rows: Earning[]) => Math.round(rows.reduce((t, e) => t + e.amount, 0) * 100) / 100;
      const channel = str(s.sales_channel);
      return {
        balance: { amount: sum(entries.filter((e) => e.status === "available")), currency: "USD" },
        total_earned: { amount: sum(entries), currency: "USD" },
        pending: { amount: sum(entries.filter((e) => e.status === "pending")), currency: "USD" },
        entries,
        help: `Profit on the latest ${ORDER_PAGES * 10} orders: what buyers paid for the items, less Printify's production and shipping cost, before the sales channel's own fees and taxes. Amounts are in the shop's currency (USD unless the shop is set otherwise). ${channel ? `${channel} pays` : "The sales channel pays"} the money out on its own schedule.`,
      };
    },
  });
}

export const printify = createPrintify();
