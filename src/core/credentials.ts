import type { Connector } from "./connector.js";
import { oauthTokensExist } from "./oauth.js";

export type CredentialOverrides = Record<string, Record<string, string | undefined>>;

/** The environment variable names a connector's auth reads. */
export function credentialNames(connector: Connector): string[] {
  if (connector.auth.type === "none") return [];
  if (connector.auth.type === "oauth") return connector.auth.env ? [connector.auth.env] : [];
  return connector.auth.env;
}

/** The credential values a connector asked for, from the caller's overrides first, then the environment. */
export function credentialsFor(
  connector: Connector,
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of credentialNames(connector)) {
    const value = overrides?.[name] ?? env[name];
    out[name] = typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  if (connector.auth.type === "oauth") {
    const token = overrides?.WORK_OAUTH_ACCESS_TOKEN;
    if (typeof token === "string" && token.trim()) out.WORK_OAUTH_ACCESS_TOKEN = token.trim();
  }
  if (env.WORK_HOSTED === "1") out.WORK_HOSTED = "1";
  return out;
}

/** Every credential the connector names is present, or (OAuth) a sign-in is stored. */
export function isConfigured(
  connector: Connector,
  credentials: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (connector.auth.type === "none") return true;
  if (connector.auth.type === "oauth") {
    if (connector.auth.env !== undefined && Boolean(credentials[connector.auth.env])) return true;
    if (credentials.WORK_OAUTH_ACCESS_TOKEN) return true;
    if (env.WORK_HOSTED === "1") return false;
    return oauthTokensExist(connector.id, env);
  }
  const sets = connector.auth.anyOf?.length ? connector.auth.anyOf : [connector.auth.env];
  return sets.some((names) => names.every((name) => Boolean(credentials[name])));
}

/** The connector can be asked at all: configured, or it declared the credential optional. */
export function canUse(
  connector: Connector,
  credentials: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (connector.auth.type === "none") return true;
  if (connector.auth.type === "oauth") return connector.auth.required !== true || isConfigured(connector, credentials, env);
  if (connector.auth.required === false) return true;
  return isConfigured(connector, credentials, env);
}
