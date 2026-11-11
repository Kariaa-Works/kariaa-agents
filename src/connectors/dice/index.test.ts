import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, testContext } from "../../core/conformance.js";
import { McpClientPool } from "../../core/mcpClient.js";
import { defineMcpConnector } from "../../core/mcp/profile.js";
import { createFakeMcp } from "../../../tests/helpers/fakeMcpServer.js";
import { dice } from "./index.js";
import { profile } from "./profile.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as { kind: string; value: unknown };
/** Captured results answer the way the real server does: structuredContent, or JSON in the text content. */
const answer = (name: string) => {
  const f = fixture(name);
  return f.kind === "structured" ? (f.value as Record<string, unknown>) : { text: JSON.stringify(f.value) };
};

const CREDS = {};
const SAMPLE = { query: "electrician" };
const fake = createFakeMcp(
  {
    search_jobs: () => answer("search_jobs"),
  },
  { requireAuth: [] },
);
const offline = defineMcpConnector(profile, { pool: new McpClientPool({ transportFactory: fake.transportFactory }) });
const live = process.env.LIVE === "1";

describeConnectorConformance(live ? dice : offline, { search: SAMPLE, expectFetch: false, minResults: live ? 1 : 1, credentials: CREDS });

describe("dice mapping", () => {
  it("maps the first result", async () => {
    const { jobs } = await offline.search!(SAMPLE, testContext({ credentials: CREDS }));
    expect(jobs[0]).toMatchObject({
      id: "030b1c85-e411-417f-aee6-0d3eaaebd9fd",
      kind: "listing",
      title: "Production Line Electrician 1",
      org: "Ingersoll Rand",
      location: { text: "Junction City, Oregon, USA", remote: false },
    });
  });
});
