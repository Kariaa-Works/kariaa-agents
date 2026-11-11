/**
 * RSS 2.0, Atom and simple XML job feeds as plain objects. Small and
 * dependency-free: enough for feeds that list one posting per element.
 */
import { decodeEntities } from "./text.js";

export type FeedItem = {
  title?: string;
  link?: string;
  /** guid (RSS) or id (Atom). */
  id?: string;
  /** description (RSS) or summary (Atom), HTML as published. */
  description?: string;
  /** content:encoded (RSS) or content (Atom), HTML as published. */
  content?: string;
  /** pubDate, published or dc:date, as published. */
  published?: string;
  updated?: string;
  categories: string[];
  author?: string;
  /** Every child element by tag name (namespace prefix kept), first value wins, text only. */
  fields: Record<string, string>;
  /** Attributes of child elements by tag name, for feeds that put data there (Atom links, enclosures). */
  attributes: Record<string, Record<string, string>>;
};

export type Feed = { title?: string; link?: string; items: FeedItem[] };

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/gu;
const CHILD = /<([A-Za-z_][\w:.-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/\1\s*>)/gu;
const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/gu;

/** Element text: entities decoded, CDATA sections taken as they are. Markup inside stays (it is usually HTML). */
export function xmlText(raw: string): string {
  let out = "";
  let last = 0;
  for (const m of raw.matchAll(CDATA)) {
    out += decodeEntities(raw.slice(last, m.index));
    out += m[1] ?? "";
    last = (m.index ?? 0) + m[0].length;
  }
  return (out + decodeEntities(raw.slice(last))).trim();
}

function attributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) out[m[1]!] = decodeEntities(m[3] ?? m[4] ?? "");
  return out;
}

function children(body: string): Array<{ tag: string; attrs: Record<string, string>; text: string; inner: string }> {
  const out: Array<{ tag: string; attrs: Record<string, string>; text: string; inner: string }> = [];
  // CDATA can hold markup that looks like elements; hide it while scanning.
  const hidden: string[] = [];
  const masked = body.replace(CDATA, (whole) => {
    hidden.push(whole);
    return `\u0000${hidden.length - 1}\u0000`;
  });
  const restore = (text: string) => text.replace(/\u0000(\d+)\u0000/gu, (_m, i: string) => hidden[Number(i)] ?? "");
  for (const m of masked.matchAll(CHILD)) {
    const inner = restore(m[4] ?? "");
    out.push({ tag: m[1]!, attrs: attributes(m[2] ?? ""), text: xmlText(inner), inner });
  }
  return out;
}

function firstOf(fields: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (value) return value;
  }
  return undefined;
}

function toItem(body: string): FeedItem {
  const fields: Record<string, string> = {};
  const attrs: Record<string, Record<string, string>> = {};
  const categories: string[] = [];
  let atomLink: string | undefined;
  for (const child of children(body)) {
    if (child.tag === "category") {
      const term = child.text || child.attrs.term || child.attrs.label;
      if (term) categories.push(term);
    }
    if (child.tag === "link" && child.attrs.href && (!child.attrs.rel || child.attrs.rel === "alternate")) atomLink ??= child.attrs.href;
    if (child.tag === "author" && !child.text.includes("<") && child.text) fields.author ??= child.text;
    if (child.tag === "author") {
      const name = children(child.inner).find((c) => c.tag === "name");
      if (name?.text) fields.author = name.text;
    }
    if (!(child.tag in fields) && child.text) fields[child.tag] = child.text;
    if (!(child.tag in attrs) && Object.keys(child.attrs).length) attrs[child.tag] = child.attrs;
  }
  const link = firstOf(fields, "link") ?? atomLink;
  return {
    ...(firstOf(fields, "title") ? { title: firstOf(fields, "title") } : {}),
    ...(link ? { link } : {}),
    ...(firstOf(fields, "guid", "id") ? { id: firstOf(fields, "guid", "id") } : {}),
    ...(firstOf(fields, "description", "summary") ? { description: firstOf(fields, "description", "summary") } : {}),
    ...(firstOf(fields, "content:encoded", "content") ? { content: firstOf(fields, "content:encoded", "content") } : {}),
    ...(firstOf(fields, "pubDate", "published", "dc:date", "pubdate")
      ? { published: firstOf(fields, "pubDate", "published", "dc:date", "pubdate") }
      : {}),
    ...(firstOf(fields, "updated", "atom:updated") ? { updated: firstOf(fields, "updated", "atom:updated") } : {}),
    categories,
    ...(firstOf(fields, "author", "dc:creator") ? { author: firstOf(fields, "author", "dc:creator") } : {}),
    fields,
    attributes: attrs,
  };
}

/**
 * Reads the postings of an RSS, Atom or plain XML feed. `itemTag` names the
 * element that holds one posting; by default `item` (RSS) or `entry` (Atom).
 */
export function parseFeed(xml: string, itemTag?: string): Feed {
  const text = xml.replace(/^\uFEFF/u, "");
  const tags = itemTag ? [itemTag] : ["item", "entry"];
  let items: FeedItem[] = [];
  for (const tag of tags) {
    if (!/^[A-Za-z_][\w:.-]*$/u.test(tag)) throw new Error(`Not an XML tag name: ${tag}`);
    const name = tag.replace(/[.]/gu, "[.]");
    const pattern = new RegExp(String.raw`<${name}\b(?:[^>"']|"[^"]*"|'[^']*')*?>([\s\S]*?)</${name}\s*>`, "gu");
    items = [...text.matchAll(pattern)].map((m) => toItem(m[1] ?? ""));
    if (items.length) break;
  }
  const head = text.split(new RegExp(String.raw`<(?:${tags.map((t) => t.replace(/[.]/gu, "[.]")).join("|")})\b`, "u"))[0] ?? "";
  const headFields = Object.fromEntries(children(head.replace(/^[\s\S]*?<(?:channel|feed)\b[^>]*>/u, "")).map((c) => [c.tag, c.text]));
  return {
    ...(headFields.title ? { title: headFields.title } : {}),
    ...(headFields.link ? { link: headFields.link } : {}),
    items,
  };
}
