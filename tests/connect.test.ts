import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { connectPlan, fileCredentialStore, helpUrl, type CredentialStore } from "../src/core/connect.js";
import { defineConnector, type Connector } from "../src/core/connector.js";
import { ProtocolError } from "../src/core/errors.js";
import { WorkProtocol } from "../src/core/router.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "work-connect-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const KEY_HELP = "Set ACME_KEY to a key from https://acme.example/settings/api. Browsing works without it.";

/** A source whose account answers by key: "good" is accepted, "slow" times out, anything else is refused. */
function acme(extra: Partial<Connector> = {}): Connector {
  return defineConnector({
    id: "acme",
    name: "Acme",
    description: "Test source.",
    kinds: ["task"],
    auth: { type: "api_key", env: ["ACME_KEY"], help: KEY_HELP, required: false },
    async search() {
      return { jobs: [] };
    },
    async account(ctx) {
      const key = ctx.credentials.ACME_KEY;
      if (key === "slow") throw new ProtocolError("timeout", "Acme did not answer.");
      if (key !== "good") return { signed_in: false, help: KEY_HELP };
      return { signed_in: true, label: "ama" };
    },
    ...extra,
  });
}

function memoryStore(initial: Record<string, Record<string, string>> = {}): CredentialStore & { data: typeof initial } {
  const data = structuredClone(initial);
  return {
    where: "memory",
    data,
    load: () => structuredClone(data),
    save: vi.fn(async (id: string, values: Record<string, string>) => {
      data[id] = { ...(data[id] ?? {}), ...values };
    }),
  };
}

const protocolWith = (connector: Connector, options: { env?: NodeJS.ProcessEnv; store?: CredentialStore } = {}) =>
  new WorkProtocol({ connectors: [connector], env: options.env ?? {}, ...(options.store ? { credentialStore: options.store } : {}) });

describe("connect", () => {
  it("gives the steps, the page and the fields for a key that is not set", async () => {
    const connection = await protocolWith(acme()).connect("acme");
    expect(connection).toMatchObject({
      connector: "acme",
      status: "action_needed",
      method: "api_key",
      url: "https://acme.example/settings/api",
      fields: ["ACME_KEY"],
    });
    expect(connection.steps?.at(-1)).toContain("save_credentials");
  });

  it("answers the account when the key works", async () => {
    const connection = await protocolWith(acme(), { env: { ACME_KEY: "good" } }).connect("acme");
    expect(connection).toMatchObject({ status: "connected", account: { signed_in: true, label: "ama" } });
  });

  it("says a kept key stopped working", async () => {
    const connection = await protocolWith(acme(), { env: { ACME_KEY: "revoked" } }).connect("acme");
    expect(connection.status).toBe("action_needed");
    expect(connection.steps?.[0]).toContain("did not work");
  });

  it("registers where the platform has a sign-up API, and keeps the key", async () => {
    const register = vi.fn(async () => ({
      credentials: { ACME_KEY: "good" },
      account_id: "ama-bot",
      next_step: "Claim it from the email.",
    }));
    const store = memoryStore();
    const protocol = protocolWith(acme({ register }), { store });
    expect(await protocol.connect("acme")).toMatchObject({ status: "action_needed", method: "register", needs: ["email"] });
    await expect(protocol.connect("acme", { email: "not an email" })).rejects.toMatchObject({ code: "invalid_input" });
    const connection = await protocol.connect("acme", { email: "ama@example.com", name: "Ama" });
    expect(register).toHaveBeenCalledWith({ email: "ama@example.com", name: "Ama" }, expect.anything());
    expect(connection).toMatchObject({
      status: "connected",
      account: { label: "ama" },
      registered: { account_id: "ama-bot", next_step: "Claim it from the email." },
      stored: "memory",
    });
    expect(store.data.acme).toEqual({ ACME_KEY: "good" });
    expect(await protocol.connect("acme", { email: "ama@example.com" })).toMatchObject({ status: "connected" });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("points OAuth sources at a sign-in", () => {
    const oauth = defineConnector({
      id: "signin",
      name: "SignIn",
      description: "Test source.",
      kinds: ["task"],
      auth: { type: "oauth", help: "Run `work login signin`." },
      async search() {
        return { jobs: [] };
      },
    });
    expect(connectPlan(oauth, { hosted: false })).toMatchObject({ method: "oauth", fields: ["WORK_OAUTH_ACCESS_TOKEN"] });
    expect(connectPlan(oauth, { hosted: false }).steps?.[0]).toContain("work login signin");
    const hosted = connectPlan(oauth, { hosted: true, connectUrl: () => "https://www.kariaa.com/datahouse/connect" });
    expect(hosted.url).toBe("https://www.kariaa.com/datahouse/connect");
  });

  it("lists every source that needs an account without registering anywhere", async () => {
    const register = vi.fn();
    const connections = await protocolWith(acme({ register })).connections();
    expect(connections).toHaveLength(1);
    expect(register).not.toHaveBeenCalled();
  });
});

describe("saveCredentials", () => {
  it("keeps a key the platform accepts", async () => {
    const store = memoryStore();
    const protocol = protocolWith(acme(), { store });
    const connection = await protocol.saveCredentials("acme", { ACME_KEY: " good " });
    expect(connection).toMatchObject({ status: "connected", account: { label: "ama" }, stored: "memory" });
    expect(store.data.acme).toEqual({ ACME_KEY: "good" });
    expect(await protocol.connect("acme")).toMatchObject({ status: "connected" });
  });

  it("refuses a key the platform refuses, and forgets it", async () => {
    const store = memoryStore();
    const protocol = protocolWith(acme(), { store });
    await expect(protocol.saveCredentials("acme", { ACME_KEY: "wrong" })).rejects.toMatchObject({ code: "auth_required" });
    expect(store.save).not.toHaveBeenCalled();
    expect((await protocol.connect("acme")).status).toBe("action_needed");
  });

  it("keeps a key it could not check, and says so", async () => {
    const store = memoryStore();
    const connection = await protocolWith(acme(), { store }).saveCredentials("acme", { ACME_KEY: "slow" });
    expect(connection.steps?.[0]).toContain("not checked");
    expect(store.data.acme).toEqual({ ACME_KEY: "slow" });
  });

  it("takes only the names the source reads", async () => {
    const protocol = protocolWith(acme());
    await expect(protocol.saveCredentials("acme", { OTHER: "x" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(protocol.saveCredentials("acme", { ACME_KEY: "  " })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(protocol.saveCredentials("acme", {})).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("uses kept keys below the environment", async () => {
    const store = memoryStore({ acme: { ACME_KEY: "good" } });
    expect((await protocolWith(acme(), { store }).connect("acme")).status).toBe("connected");
    expect((await protocolWith(acme(), { store, env: { ACME_KEY: "revoked" } }).connect("acme")).status).toBe("action_needed");
  });
});

describe("fileCredentialStore", () => {
  it("saves, merges, loads and forgets, in a file only the user reads", async () => {
    const env = { WORK_CACHE_DIR: tmp };
    const store = fileCredentialStore(env);
    await store.save("acme", { ACME_KEY: "one" });
    await store.save("acme", { ACME_SECRET: "two" });
    await store.save("other", { OTHER_KEY: "three" });
    expect(fileCredentialStore(env).load!()).toEqual({ acme: { ACME_KEY: "one", ACME_SECRET: "two" }, other: { OTHER_KEY: "three" } });
    if (process.platform !== "win32") expect(statSync(store.where).mode & 0o777).toBe(0o600);
    expect(await store.forget!("acme")).toBe(true);
    expect(await store.forget!("acme")).toBe(false);
    expect(JSON.parse(readFileSync(store.where, "utf8"))).toEqual({ other: { OTHER_KEY: "three" } });
  });

  it("reads a damaged file as empty", () => {
    expect(fileCredentialStore({ WORK_CACHE_DIR: path.join(tmp, "missing") }).load!()).toEqual({});
  });
});

describe("helpUrl", () => {
  it("finds the first https link without trailing punctuation", () => {
    expect(helpUrl("Create one at https://whop.com/apps. Then set it.")).toBe("https://whop.com/apps");
    expect(helpUrl("No link here.")).toBeUndefined();
  });
});
