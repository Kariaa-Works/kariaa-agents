/**
 * Getting an agent onto a platform: what each connector needs, a self-serve sign-up where the
 * platform has one, and somewhere to keep the key once the person has it.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connector } from "./connector.js";
import type { CredentialOverrides } from "./credentials.js";
import type { Account } from "./types.js";

export type ConnectMethod = "none" | "register" | "oauth" | "api_key";

export type Connection = {
  connector: string;
  name: string;
  /** connected: ready to use. action_needed: `steps` say what the person or agent does next. */
  status: "connected" | "action_needed";
  method: ConnectMethod;
  /** The account the credentials reach, when the connector can tell. */
  account?: Account;
  /** Set when this call created the account. */
  registered?: { account_id?: string; next_step?: string };
  /** What to do next, in order. */
  steps?: string[];
  /** The names save_credentials takes for this connector. */
  fields?: string[];
  /** Where the person signs in or creates the key. */
  url?: string;
  /** Inputs connect_account needs to register on its own, such as the owner's email. */
  needs?: string[];
  /** Where the credentials are kept: a file on this machine, the person's vault, or this session only. */
  stored?: string;
};

/** Keeps credentials between sessions. */
export interface CredentialStore {
  /** Human-readable place, for messages: a path or "your vault". */
  readonly where: string;
  /** Values saved earlier, by connector id. */
  load?(): CredentialOverrides;
  /** Merges `values` into what is kept for the connector. */
  save(connectorId: string, values: Record<string, string>): Promise<void>;
  /** Forgets the connector's credentials. */
  forget?(connectorId: string): Promise<boolean>;
}

export function credentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.WORK_CACHE_DIR?.trim() || path.join(os.homedir(), ".cache", "work-protocol");
  return path.join(base, "credentials.json");
}

type Stored = Record<string, Record<string, string>>;

function readStored(file: string): Stored {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [id, values] of Object.entries(parsed as Record<string, unknown>)) {
      if (!values || typeof values !== "object" || Array.isArray(values)) continue;
      const bag: Record<string, string> = {};
      for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) bag[name] = value.trim();
      }
      if (Object.keys(bag).length) out[id] = bag;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStored(file: string, data: Stored): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/** A JSON file only this user can read, next to the OAuth tokens `work login` keeps. */
export function fileCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const file = credentialsFile(env);
  return {
    where: file,
    load: () => readStored(file),
    async save(connectorId, values) {
      const data = readStored(file);
      data[connectorId] = { ...(data[connectorId] ?? {}), ...values };
      writeStored(file, data);
    },
    async forget(connectorId) {
      const data = readStored(file);
      if (!data[connectorId]) return false;
      delete data[connectorId];
      if (Object.keys(data).length) writeStored(file, data);
      else rmSync(file, { force: true });
      return true;
    },
  };
}

/** The first https link in a help text: usually the page where the key is made. */
export function helpUrl(help: string | undefined): string | undefined {
  return help?.match(/https:\/\/[^\s)"'`,]+/u)?.[0]?.replace(/[.:;]+$/u, "");
}

/** The names save_credentials accepts for a connector. */
export function saveableNames(connector: Connector): string[] {
  if (connector.auth.type === "none") return [];
  if (connector.auth.type === "oauth") return [connector.auth.env ?? "WORK_OAUTH_ACCESS_TOKEN"];
  return [...connector.auth.env];
}

/** What it takes to connect a connector that has no working credential yet. */
export function connectPlan(
  connector: Connector,
  options: { hosted: boolean; connectUrl?: (connectorId: string) => string | undefined; rejected?: string },
): Connection {
  const base = { connector: connector.id, name: connector.name, status: "action_needed" as const };
  const auth = connector.auth;
  const rejected = options.rejected ? [`The saved credential did not work: ${options.rejected}`] : [];
  const fields = saveableNames(connector);
  const save = `Send it with save_credentials (connector "${connector.id}", ${fields.map((f) => `${f}: "…"`).join(", ")}); it is checked against ${connector.name} before it is kept.`;
  const hostedUrl = options.connectUrl?.(connector.id);
  if (typeof connector.register === "function") {
    return {
      ...base,
      method: "register",
      needs: ["email"],
      fields,
      steps: [
        ...rejected,
        `Call connect_account again with the owner's email: it registers an agent account on ${connector.name} through its sign-up API and keeps the key. The owner gets an email to claim the account.`,
        `Already have a key? ${save}`,
      ],
    };
  }
  if (auth.type === "oauth") {
    const url = hostedUrl ?? helpUrl(auth.help);
    return {
      ...base,
      method: "oauth",
      fields,
      ...(url ? { url } : {}),
      steps: [
        ...rejected,
        hostedUrl
          ? `Ask the person to open ${hostedUrl} and sign in to ${connector.name}; the sign-in is kept in their vault.`
          : options.hosted
            ? `Ask the person to connect ${connector.name} from their dashboard. ${auth.help}`
            : `Ask the person to run \`work login ${connector.id}\` and sign in to ${connector.name} in the browser that opens.`,
        `Or, with an access token: ${save}`,
      ],
    };
  }
  if (auth.type === "api_key") {
    const url = helpUrl(auth.help);
    return {
      ...base,
      method: "api_key",
      fields,
      ...(url ? { url } : {}),
      steps: [
        ...rejected,
        `Ask the person for ${fields.join(" and ")}. ${auth.help}`,
        ...(hostedUrl ? [`They can paste it at ${hostedUrl}, or give it to you.`] : []),
        save,
      ],
    };
  }
  return { ...base, status: "connected", method: "none" };
}
