import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defineConnector } from "../src/core/connector.js";
import { WorkProtocol } from "../src/core/router.js";
import { currentTenant, perTenant, runAsTenant, stateDir } from "../src/core/tenant.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "work-tenant-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const env = { WORK_CACHE_DIR: tmp };

/** A source that stages applications in a file and remembers them in memory, like the ATS connectors. */
function staging() {
  class Store {
    private memory: Record<string, string> | undefined;
    constructor(private readonly file: string) {}
    all(): Record<string, string> {
      if (this.memory) return this.memory;
      try {
        this.memory = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
      } catch {
        this.memory = {};
      }
      return this.memory;
    }
    put(id: string, note: string): void {
      const all = { ...this.all(), [id]: note };
      this.memory = all;
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(all));
    }
  }
  const store = perTenant(() => new Store(path.join(stateDir(env), "staging.json")));
  return defineConnector({
    id: "staging",
    name: "Staging",
    description: "Test source.",
    kinds: ["listing"],
    auth: { type: "none" },
    async search() {
      return { jobs: [] };
    },
    async apply(native, input) {
      store().put(native, input.note ?? "");
      return { id: native, job_id: native, stage: "applied" };
    },
    async list() {
      return Object.keys(store().all()).map((id) => ({ id, job_id: id, stage: "applied" as const }));
    },
  });
}

describe("tenant scope", () => {
  it("gives each tenant its own folder and the local user the plain one", () => {
    expect(stateDir(env)).toBe(tmp);
    const a = runAsTenant("user-a", () => stateDir(env));
    const b = runAsTenant("user-b", () => stateDir(env));
    expect(a).not.toBe(b);
    expect(a.startsWith(path.join(tmp, "tenants"))).toBe(true);
    expect(a).not.toContain("user-a");
    expect(runAsTenant(undefined, () => currentTenant())).toBeUndefined();
  });

  it("keeps one person's staged applications out of another's list", async () => {
    const connector = staging();
    const forA = new WorkProtocol({ connectors: [connector], tenant: "user-a", cache: null });
    const forB = new WorkProtocol({ connectors: [connector], tenant: "user-b", cache: null });
    await forA.apply("staging:job-1", { note: "cv of a" });
    expect((await forA.list()).applications.map((a) => a.id)).toEqual(["staging:job-1"]);
    expect((await forB.list()).applications).toEqual([]);
    // A fresh process (new instances) still keeps them apart on disk.
    const again = staging();
    const laterB = new WorkProtocol({ connectors: [again], tenant: "user-b", cache: null });
    expect((await laterB.list()).applications).toEqual([]);
  });
});
