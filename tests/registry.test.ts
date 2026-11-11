import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { builtInConnectors } from "../src/connectors/index.js";
import { defineConnector, stagesOf, type Connector } from "../src/core/connector.js";
import { ProtocolError } from "../src/core/errors.js";
import { Registry, connectorModulesFromEnv, loadConnectorModules } from "../src/core/registry.js";
import { CONNECTOR_CATEGORIES } from "../src/core/types.js";
import { VERSION } from "../src/core/version.js";
import { fullStageConnector, searchOnlyConnector } from "./helpers/fakeConnectors.js";

const root = path.resolve(import.meta.dirname, "..");

describe("Registry", () => {
  it("registers connectors once and derives their stages", () => {
    const registry = new Registry();
    registry.register(fullStageConnector()).register(searchOnlyConnector());
    expect(registry.list().map((c) => c.id)).toEqual(["fake-tasks", "fake-board"]);
    expect(() => registry.register(searchOnlyConnector())).toThrow(ProtocolError);
    expect(stagesOf(registry.get("fake-board")!)).toEqual(["search"]);
    expect(stagesOf(registry.get("fake-tasks")!)).toEqual([
      "search",
      "get",
      "apply",
      "upload",
      "remove",
      "submit",
      "status",
      "list",
      "link",
      "account",
      "earnings",
      "payout",
    ]);
  });

  it("refuses connectors that break the contract", () => {
    const registry = new Registry();
    expect(() =>
      registry.register({
        id: "Bad",
        name: "x",
        description: "y",
        kinds: ["task"],
        auth: { type: "none" },
        async search() {
          return { jobs: [] };
        },
      }),
    ).toThrow(/Connector id/u);
    expect(() => registry.register({ id: "nostage", name: "x", description: "y", kinds: ["task"], auth: { type: "none" } })).toThrow(
      /no stage/u,
    );
    expect(() =>
      registry.register({
        id: "nokinds",
        name: "x",
        description: "y",
        kinds: [],
        auth: { type: "none" },
        async search() {
          return { jobs: [] };
        },
      }),
    ).toThrow(/kinds/u);
  });

  it("loads out-of-tree connector modules", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "work-protocol-mod-"));
    const file = path.join(dir, "my-connector.mjs");
    writeFileSync(
      file,
      `export const connector = { id: "my-board", name: "My board", description: "Mine", kinds: ["listing"], auth: { type: "none" }, async search() { return { jobs: [{ id: "1", kind: "listing", title: "Hi" }] }; } };`,
    );
    const registry = new Registry();
    const ids = await loadConnectorModules([file], registry);
    expect(ids).toEqual(["my-board"]);
    expect(registry.get("my-board")?.name).toBe("My board");
    await expect(loadConnectorModules([path.join(dir, "missing.mjs")], registry)).rejects.toMatchObject({ code: "invalid_input" });
    writeFileSync(path.join(dir, "empty.mjs"), "export const nothing = 1;");
    await expect(loadConnectorModules([path.join(dir, "empty.mjs")], new Registry())).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("exports no connector"),
    });
    expect(connectorModulesFromEnv({ WORK_CONNECTOR_MODULES: " ./a.js, @acme/b ,, " })).toEqual(["./a.js", "@acme/b"]);
  });
});

describe("built-in connectors", () => {
  it("includes every connector folder except the template", async () => {
    const dir = path.join(root, "src", "connectors");
    const folders = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => d.name);
    expect(folders.length).toBeGreaterThanOrEqual(6);
    const registered = new Set(builtInConnectors.map((c) => c.id));
    for (const folder of folders) {
      const mod = (await import(`../src/connectors/${folder}/index.ts`)) as Record<string, unknown>;
      const exported = Object.values(mod).filter(
        (v): v is Connector =>
          Boolean(v) && typeof v === "object" && typeof (v as Connector).id === "string" && typeof (v as Connector).search === "function",
      );
      expect(exported.length, `${folder} exports no connector`).toBeGreaterThan(0);
      for (const connector of exported)
        expect(registered.has(connector.id), `${connector.id} from ${folder} is not in builtInConnectors`).toBe(true);
    }
    expect(new Set(builtInConnectors.map((c) => c.id)).size).toBe(builtInConnectors.length);
  });

  it("says how every built-in connector pays", () => {
    for (const c of builtInConnectors) {
      expect(CONNECTOR_CATEGORIES, `${c.id} has no category`).toContain(c.category);
      expect(c.payoutRails?.length ?? 0, `${c.id} has no payout rails`).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown category or payout rail", () => {
    const base = {
      id: "bad-pay",
      name: "Bad",
      description: "x",
      kinds: ["task"] as const,
      auth: { type: "none" as const },
      search: async () => ({ jobs: [] }),
    };
    expect(() => defineConnector({ ...base, category: "trading" as never })).toThrow(ProtocolError);
    expect(() => defineConnector({ ...base, payoutRails: ["gold"] as never })).toThrow(ProtocolError);
  });

  it("includes every verifier folder except the template, all deterministic", async () => {
    const { builtInVerifiers } = await import("../src/verifiers/index.js");
    const dir = path.join(root, "src", "verifiers");
    const folders = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => d.name);
    const registered = new Set(builtInVerifiers.map((v) => v.id));
    for (const folder of folders) {
      const mod = (await import(`../src/verifiers/${folder}/index.ts`)) as Record<string, unknown>;
      const exported = Object.values(mod).filter(
        (v): v is { id: string; verify: unknown } =>
          Boolean(v) && typeof v === "object" && typeof (v as { verify?: unknown }).verify === "function",
      );
      expect(exported.length, `${folder} exports no verifier`).toBeGreaterThan(0);
      for (const verifier of exported)
        expect(registered.has(verifier.id), `${verifier.id} from ${folder} is not in builtInVerifiers`).toBe(true);
    }
    expect(builtInVerifiers.every((v) => v.deterministic)).toBe(true);
  });

  it("loads out-of-tree verifier modules", async () => {
    const { loadVerifierModules, verifierModulesFromEnv } = await import("../src/core/registry.js");
    const dir = mkdtempSync(path.join(os.tmpdir(), "work-protocol-ver-"));
    const file = path.join(dir, "my-verifier.mjs");
    writeFileSync(
      file,
      `export const verifier = { id: "my-check", name: "Mine", description: "d", deterministic: true, verify: () => ({ verifier: "my-check", outcome: "pass", checks: [] }) };`,
    );
    const loaded = await loadVerifierModules([file]);
    expect(loaded.map((v) => v.id)).toEqual(["my-check"]);
    writeFileSync(
      path.join(dir, "bad.mjs"),
      `export const verifier = { id: "Bad Id", name: "x", description: "y", deterministic: true, verify() {} };`,
    );
    await expect(loadVerifierModules([path.join(dir, "bad.mjs")])).rejects.toMatchObject({ code: "invalid_input" });
    expect(verifierModulesFromEnv({ WORK_VERIFIER_MODULES: "./a.js, ./b.js" })).toEqual(["./a.js", "./b.js"]);
  });

  it("documents every credential in .env.example", () => {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    for (const connector of builtInConnectors) {
      if (connector.auth.type !== "api_key") continue;
      for (const name of connector.auth.env) expect(example, `${name} missing from .env.example`).toContain(name);
    }
  });

  it("keeps VERSION in step with package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
