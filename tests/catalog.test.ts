import { describe, expect, it } from "vitest";
import { builtInConnectors } from "../src/connectors/index.js";
import { defineConnector, type Connector } from "../src/core/connector.js";
import { WorkProtocol } from "../src/core/router.js";

function source(id: string, extra: Partial<Connector> = {}): Connector {
  return defineConnector({
    id,
    name: id,
    description: "Test source.",
    kinds: ["task"],
    auth: { type: "none" },
    async search() {
      return { jobs: [{ id: "1", kind: "task" as const, title: `${id} task`, url: `https://${id}.example/1` }] };
    },
    ...extra,
  });
}

const sources = () => [source("good", { tier: "self" }), source("other")];
const searched = async (protocol: WorkProtocol, connectors?: string[]) =>
  [
    ...new Set((await protocol.search({ query: "task", ...(connectors ? { connectors } : {}) })).jobs.map((j) => j.id.split(":")[0])),
  ].sort();

describe("curated catalog", () => {
  it("searches only catalog sources when any are registered", async () => {
    const protocol = new WorkProtocol({ connectors: sources(), env: {}, cache: null });
    expect(await searched(protocol)).toEqual(["good"]);
    const info = protocol.connectors();
    expect(info.find((c) => c.id === "good")).toMatchObject({ tier: "self" });
    expect(info.find((c) => c.id === "other")).toMatchObject({ opt_in: true });
  });

  it("still searches a source outside the catalog when it is named", async () => {
    const protocol = new WorkProtocol({ connectors: sources(), env: {}, cache: null });
    expect(await searched(protocol, ["other"])).toEqual(["other"]);
  });

  it("opens everything with WORK_CATALOG=all, and treats a set with no catalog source as all", async () => {
    expect(await searched(new WorkProtocol({ connectors: sources(), env: { WORK_CATALOG: "all" }, cache: null }))).toEqual([
      "good",
      "other",
    ]);
    expect(await searched(new WorkProtocol({ connectors: [source("a"), source("b")], env: {}, cache: null }))).toEqual(["a", "b"]);
  });

  it("ships the audited platforms in their tiers", () => {
    const tiers = Object.fromEntries(builtInConnectors.filter((c) => c.tier && !c.optIn).map((c) => [c.id, c.tier]));
    expect(tiers).toEqual({
      kariaa: "managed",
      "near-agent-market": "managed",
      "superteam-earn": "managed",
      kaggle: "self",
      "whop-bounties": "self",
      algora: "discover",
      yeswehack: "discover",
    });
  });

  it("lets Kariaa set up every managed account, and keeps selling platforms out", () => {
    for (const c of builtInConnectors.filter((x) => x.tier === "managed" && x.id !== "kariaa")) {
      expect(typeof c.register, c.id).toBe("function");
    }
    expect(builtInConnectors.filter((c) => c.tier && c.category === "selling").map((c) => c.id)).toEqual([]);
  });
});

describe("discover tier", () => {
  const listing = (calls: string[]) =>
    source("board", {
      tier: "discover",
      homepage: "https://board.example",
      async apply(native) {
        calls.push(`apply ${native}`);
        return { id: native, job_id: native, stage: "applied" as const };
      },
    });

  it("shows no action stages on its jobs, and points at the listing", async () => {
    const protocol = new WorkProtocol({ connectors: [listing([])], env: {} });
    const [job] = (await protocol.search({ query: "task" })).jobs;
    expect(job!.stages).not.toContain("apply");
    expect(job!.apply_hint).toBe("Apply at https://board.example/1");
  });

  it("hands every action to the person with the listing's link, without calling the platform", async () => {
    const calls: string[] = [];
    const protocol = new WorkProtocol({ connectors: [listing(calls)], env: {} });
    await protocol.search({ query: "task" });
    await expect(protocol.apply("board:1")).rejects.toMatchObject({
      code: "handoff_required",
      connector: "board",
      details: { stage: "apply", handoff: { url: "https://board.example/1", title: "board task" } },
    });
    await expect(protocol.submit("board:app-1")).rejects.toMatchObject({ code: "handoff_required", details: { stage: "submit" } });
    expect(calls).toEqual([]);
  });
});
