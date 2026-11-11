import { describe, expect, it } from "vitest";
import { defineConnector, type Connector } from "../src/core/connector.js";
import { WorkProtocol } from "../src/core/router.js";
import type { NativeJob } from "../src/core/types.js";

/** A live source that answers every search with the same listings, whatever the words: like several real ones. */
function source(id: string, category: Connector["category"], jobs: Partial<NativeJob>[]): Connector {
  return defineConnector({
    id,
    name: id,
    description: "Test.",
    kinds: ["task"],
    category,
    payoutRails: ["fiat"],
    tier: "self",
    auth: { type: "none" },
    async search() {
      return {
        jobs: jobs.map((j, i) => ({ id: `${i}`, kind: "task" as const, title: "untitled", url: `https://${id}.example/${i}`, ...j })),
      };
    },
  });
}

const search = (connectors: Connector[], query: string) =>
  new WorkProtocol({ connectors, env: {}, cache: null }).search({ query, limit: 10 }).then((r) => r.jobs.map((j) => j.id));

describe("live search relevance", () => {
  it("drops a listing that only shares one word of a two-word query, keeps one that names it in the title", async () => {
    const board = source("board", "job", [
      { title: "Live singing project", description: "We are learning a lot this year." },
      { title: "Machine learning model for churn" },
      { title: "Data work", description: "Classic machine learning on tabular data." },
    ]);
    expect(await search([board], "machine learning")).toEqual(["board:1", "board:2"]);
  });

  it("matches plurals both ways", async () => {
    const board = source("board", "bounty", [{ title: "Acme program", summary: "Report vulnerabilities in the API." }]);
    expect(await search([board], "vulnerability")).toEqual(["board:0"]);
  });

  it("shows a listing posted twice under different links once", async () => {
    const board = source("board", "bounty", [
      { title: "Write a Python CSV parser", pay: { min: 100, max: 100, currency: "USDC", period: "unit", text: "100 USDC" } },
      { title: "Write a Python CSV parser", pay: { min: 100, max: 100, currency: "USDC", period: "unit", text: "100 USDC" } },
    ]);
    expect(await search([board], "python")).toEqual(["board:0"]);
  });

  it("puts the kind of work the query names first, and a source's own subject tag counts like a title", async () => {
    const bounties = source("bounties", "bounty", [{ title: "Netflix", tags: ["security", "bug-bounty"] }]);
    const contests = source("contests", "competition", [{ title: "Security image challenge" }]);
    expect(await search([contests, bounties], "security bug bounty")).toEqual(["bounties:0", "contests:0"]);
  });
});
