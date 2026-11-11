/**
 * OAuth for linked MCP servers: a file-backed client provider for the SDK's
 * auth flow. `work login <id>` fills the file; connectors read it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export function oauthDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.WORK_CACHE_DIR?.trim() || path.join(os.homedir(), ".cache", "work-protocol");
  return path.join(base, "oauth");
}

export function oauthFile(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(oauthDir(env), `${id}.json`);
}

type Stored = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  saved_at?: string;
};

function read(file: string): Stored {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Stored;
  } catch {
    return {};
  }
}

function write(file: string, data: Stored): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...data, saved_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function oauthTokensExist(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = oauthFile(id, env);
  return existsSync(file) && Boolean(read(file).tokens?.access_token);
}

export function clearOAuth(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = oauthFile(id, env);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export type FileOAuthProviderOptions = {
  env?: NodeJS.ProcessEnv;
  /** Port of the local callback server. Default 8790. */
  redirectPort?: number;
  scope?: string;
  /** Called with the authorization URL the person must open. Default: printed to stderr. */
  onAuthorize?: (url: URL) => void | Promise<void>;
};

export class FileOAuthProvider implements OAuthClientProvider {
  readonly id: string;
  readonly file: string;
  private readonly port: number;
  private readonly scope: string | undefined;
  private readonly onAuthorize: ((url: URL) => void | Promise<void>) | undefined;
  private currentState: string | undefined;

  constructor(id: string, options: FileOAuthProviderOptions = {}) {
    this.id = id;
    this.file = oauthFile(id, options.env);
    this.port = options.redirectPort ?? 8790;
    this.scope = options.scope;
    this.onAuthorize = options.onAuthorize;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Work Protocol",
      client_uri: "https://github.com/Kariaa-Works/kariaa-agents",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  state(): string {
    this.currentState = randomBytes(16).toString("hex");
    return this.currentState;
  }

  /** The state the last authorization started with; the callback must echo it. */
  get expectedState(): string | undefined {
    return this.currentState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return read(this.file).client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    write(this.file, { ...read(this.file), client });
  }

  tokens(): OAuthTokens | undefined {
    return read(this.file).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    write(this.file, { ...read(this.file), tokens });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.onAuthorize) await this.onAuthorize(url);
    else process.stderr.write(`Open this URL to sign in to ${this.id}:\n${url.href}\n`);
  }

  saveCodeVerifier(verifier: string): void {
    write(this.file, { ...read(this.file), verifier });
  }

  codeVerifier(): string {
    const verifier = read(this.file).verifier;
    if (!verifier) throw new Error(`No code verifier saved for ${this.id}; start the sign-in again.`);
    return verifier;
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    write(this.file, { ...read(this.file), discovery });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return read(this.file).discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const data = read(this.file);
    if (scope === "all") {
      write(this.file, {});
      return;
    }
    if (scope === "client") delete data.client;
    if (scope === "tokens") delete data.tokens;
    if (scope === "verifier") delete data.verifier;
    if (scope === "discovery") delete data.discovery;
    write(this.file, data);
  }
}
