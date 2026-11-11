import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, jsonResponse, testContext } from "../src/core/conformance.js";
import { parseFeed, xmlText, type FeedItem } from "../src/core/feed.js";
import { defineFeedBoard, defineJsonBoard, iso, str } from "../src/core/jsonBoard.js";
import { stripHtml } from "../src/core/text.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Example Jobs</title>
  <link>https://jobs.example/</link>
  <item>
    <title><![CDATA[Senior Rust Engineer & Lead]]></title>
    <link>https://jobs.example/j/1</link>
    <guid isPermaLink="false">job-1</guid>
    <description><![CDATA[<p>Build <b>things</b> &amp; ship.</p>]]></description>
    <content:encoded><![CDATA[<p>Full text with <a href="https://x.example">a link</a>.</p>]]></content:encoded>
    <pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate>
    <category>Engineering</category>
    <category><![CDATA[Remote]]></category>
    <dc:creator>Acme &amp; Co</dc:creator>
    <region>Europe</region>
    <enclosure url="https://jobs.example/logo.png" type="image/png" length="10"/>
  </item>
  <item>
    <title>Nurse (night shift)</title>
    <link>https://jobs.example/j/2</link>
    <guid>https://jobs.example/j/2</guid>
    <description>&lt;p&gt;Care for patients, 3 nights a week.&lt;/p&gt;</description>
    <pubDate>Sun, 18 Oct 2026 09:30:00 +0200</pubDate>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Board</title>
  <entry>
    <title type="html">Data &amp;amp; ML contractor</title>
    <link rel="self" href="https://atom.example/api/e/9"/>
    <link rel="alternate" href="https://atom.example/e/9"/>
    <id>tag:atom.example,2026:9</id>
    <published>2026-10-17T08:00:00Z</published>
    <updated>2026-10-18T08:00:00Z</updated>
    <summary>Short summary</summary>
    <author><name>Beta Labs</name><email>x@beta.example</email></author>
    <category term="contract"/>
  </entry>
</feed>`;

const XML_JOBS = `<jobs><job><id>77</id><title>Welder</title><company>Steel Ltd</company><city>Leeds</city></job><job><id>78</id><title>Plumber</title><company>Pipes</company><city>York</city></job></jobs>`;

describe("parseFeed", () => {
  it("reads RSS items: CDATA, entities, categories, namespaced fields and attributes", () => {
    const feed = parseFeed(RSS);
    expect(feed.title).toBe("Example Jobs");
    expect(feed.link).toBe("https://jobs.example/");
    expect(feed.items).toHaveLength(2);
    const [first, second] = feed.items as [FeedItem, FeedItem];
    expect(first).toMatchObject({
      title: "Senior Rust Engineer & Lead",
      link: "https://jobs.example/j/1",
      id: "job-1",
      published: "Mon, 19 Oct 2026 10:00:00 GMT",
      categories: ["Engineering", "Remote"],
      author: "Acme & Co",
    });
    expect(first.description).toBe("<p>Build <b>things</b> &amp; ship.</p>");
    expect(stripHtml(first.description)).toBe("Build things & ship.");
    expect(first.content).toContain('<a href="https://x.example">a link</a>');
    expect(first.fields.region).toBe("Europe");
    expect(first.attributes.enclosure).toEqual({ url: "https://jobs.example/logo.png", type: "image/png", length: "10" });
    expect(second.description).toBe("<p>Care for patients, 3 nights a week.</p>");
    expect(iso(second.published)).toBe("2026-10-18T07:30:00.000Z");
  });

  it("reads Atom entries: alternate link, id, dates and author name", () => {
    const feed = parseFeed(ATOM);
    expect(feed.title).toBe("Atom Board");
    expect(feed.items[0]).toMatchObject({
      title: "Data &amp; ML contractor",
      link: "https://atom.example/e/9",
      id: "tag:atom.example,2026:9",
      published: "2026-10-17T08:00:00Z",
      updated: "2026-10-18T08:00:00Z",
      description: "Short summary",
      categories: ["contract"],
      author: "Beta Labs",
    });
  });

  it("reads plain XML with a named item element, and nothing from an empty or broken body", () => {
    const feed = parseFeed(XML_JOBS, "job");
    expect(feed.items.map((i) => [i.fields.id, i.title, i.fields.company, i.fields.city])).toEqual([
      ["77", "Welder", "Steel Ltd", "Leeds"],
      ["78", "Plumber", "Pipes", "York"],
    ]);
    expect(parseFeed("").items).toEqual([]);
    expect(parseFeed("<html><body>Not a feed</body></html>").items).toEqual([]);
    expect(() => parseFeed(XML_JOBS, "bad tag")).toThrow(/tag name/u);
    expect(xmlText(" <![CDATA[a &amp; b]]> ")).toBe("a &amp; b");
    expect(xmlText("a &amp; b")).toBe("a & b");
  });
});

const feedBoard = defineFeedBoard({
  id: "example-feed",
  name: "Example feed",
  description: "An RSS board in tests.",
  request: () => "https://jobs.example/feed.rss",
  map: (row) => {
    const item = row as FeedItem;
    if (!item.title || !item.link) return null;
    return {
      id: item.id ?? item.link,
      kind: "listing",
      title: item.title,
      ...(item.author ? { org: item.author } : {}),
      ...(item.description ? { summary: stripHtml(item.description, 300) } : {}),
      url: item.link,
      ...(iso(item.published) ? { posted_at: iso(item.published) } : {}),
      tags: [...item.categories, "source:example-feed"],
    };
  },
  cacheTtlMs: 60_000,
});

const rssFetch = fixtureFetch(() => new Response(RSS, { headers: { "content-type": "application/rss+xml" } }));
describeConnectorConformance(feedBoard, { search: { query: "rust" }, fetch: rssFetch, expectQueryInUrl: false, live: false });

describe("defineFeedBoard", () => {
  it("maps feed items and filters the words here", async () => {
    const { jobs } = await feedBoard.search!({ query: "nurse" }, testContext({ fetch: rssFetch }));
    expect(jobs).toEqual([
      {
        id: "https://jobs.example/j/2",
        kind: "listing",
        title: "Nurse (night shift)",
        summary: "Care for patients, 3 nights a week.",
        url: "https://jobs.example/j/2",
        posted_at: "2026-10-18T07:30:00.000Z",
        tags: ["source:example-feed"],
      },
    ]);
  });

  it("asks for a feed, and finds nothing in a page that is not one", async () => {
    let accept = "";
    const html = fixtureFetch((_url, init) => {
      accept = String((init?.headers as Record<string, string>)?.accept ?? "");
      return new Response("<html>maintenance</html>", { headers: { "content-type": "text/html" } });
    });
    const { jobs } = await feedBoard.search!({}, testContext({ fetch: html }));
    expect(jobs).toEqual([]);
    expect(accept).toContain("application/rss+xml");
  });
});

describe("defineJsonBoard requests", () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const api = fixtureFetch((url, init) => {
    seen.push({ url, init });
    if (!(init?.headers as Record<string, string>)?.["x-api-key"]) return jsonResponse({ error: "no key" }, 401);
    return { results: [{ ref: "t1", name: "Translate a menu", reward: 40 }] };
  });
  const keyed = defineJsonBoard({
    id: "keyed-tasks",
    name: "Keyed tasks",
    description: "A POST search with a key header.",
    kinds: ["task"],
    optIn: true,
    auth: { type: "api_key", env: ["KEYED_TASKS_KEY"], help: "Free key at https://keyed.example/keys", required: true },
    request: (query, credentials) => ({
      url: "https://keyed.example/api/search",
      body: { keywords: query.query ?? "", page: 1 },
      ...(credentials.KEYED_TASKS_KEY ? { headers: { "x-api-key": credentials.KEYED_TASKS_KEY } } : {}),
    }),
    rows: (body) => (body as { results: unknown[] }).results,
    map: (row) => {
      const r = row as Record<string, unknown>;
      return { id: str(r.ref)!, kind: "task", title: str(r.name)!, pay: { min: Number(r.reward), currency: "USD", period: "unit" } };
    },
    applies: { query: true },
  });

  it("posts a JSON body with headers from the credentials, and keeps the kind and opt-in flag", async () => {
    expect(keyed.kinds).toEqual(["task"]);
    expect(keyed.optIn).toBe(true);
    const { jobs } = await keyed.search!({ query: "menu" }, testContext({ fetch: api, credentials: { KEYED_TASKS_KEY: "k1" } }));
    expect(jobs.map((j) => j.title)).toEqual(["Translate a menu"]);
    const last = seen.at(-1)!;
    expect(last.url).toBe("https://keyed.example/api/search");
    expect(last.init?.method).toBe("POST");
    expect(JSON.parse(String(last.init?.body))).toEqual({ keywords: "menu", page: 1 });
    expect((last.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("answers auth_required with the help when the key is refused", async () => {
    await expect(keyed.search!({ query: "menu" }, testContext({ fetch: api, credentials: {} }))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("https://keyed.example/keys"),
    });
  });
});
