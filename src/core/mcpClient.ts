/**
 * One pool of MCP clients for every linked server: one connected client per
 * transport + credential, memoized connects, tool calls with a budget, and
 * the generic mapping of MCP failures onto ProtocolErrors.
 */
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "./connector.js";
import { ProtocolError, isProtocolError, type ErrorCode as ProtocolCode } from "./errors.js";
import { USER_AGENT, VERSION } from "./version.js";

export type McpTransportSpec =
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      authProvider?: OAuthClientProvider;
      /** The fetch the connection uses (a connector passes ctx.fetch). Not part of the connection's identity. */
      fetch?: typeof fetch;
    }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

export type McpToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
};

export type McpTransportFactory = (spec: McpTransportSpec) => Transport;

export type McpErrorHints = {
  /** The server's name, for messages. */
  label: string;
  /** Where credentials come from, shown on auth failures. */
  help?: string;
  /** Upstream error codes the profile knows, mapped to protocol codes. */
  errors?: Record<string, ProtocolCode>;
};

const providerIds = new WeakMap<object, number>();
let nextProviderId = 1;

/** The identity of a transport spec: same key, same connection. */
export function transportKey(spec: McpTransportSpec): string {
  if (spec.type === "stdio") return JSON.stringify(["stdio", spec.command, spec.args ?? [], spec.env ?? {}]);
  let providerId = 0;
  if (spec.authProvider) {
    providerId = providerIds.get(spec.authProvider) ?? nextProviderId++;
    providerIds.set(spec.authProvider, providerId);
  }
  return JSON.stringify(["http", spec.url, spec.headers ?? {}, providerId]);
}

export const defaultMcpTransport: McpTransportFactory = (spec) => {
  if (spec.type === "stdio") {
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
      stderr: "pipe",
    });
  }
  return new StreamableHTTPClientTransport(new URL(spec.url), {
    requestInit: { headers: { "user-agent": USER_AGENT, ...(spec.headers ?? {}) } },
    ...(spec.authProvider ? { authProvider: spec.authProvider } : {}),
    ...(spec.fetch ? { fetch: spec.fetch } : {}),
  });
};

export function toolResultText(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/** The result as JSON: structuredContent, else the text content parsed as JSON (an array becomes `{ items }`). */
export function toolResultJson(result: McpToolResult, label: string, tool: string): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = toolResultText(result).trim();
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return { items: parsed };
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // not JSON
    }
  }
  throw new ProtocolError("upstream_error", `${label} answered ${tool} with text, not JSON; a code connector is needed to read it.`, {
    details: { tool, text: text.slice(0, 200) },
  });
}

const MISSING_TOOL = /Tool (\S+) not found/iu;

function guessCode(code: string, message: string, hints: McpErrorHints): ProtocolCode {
  const known = hints.errors?.[code];
  if (known) return known;
  const text = `${code} ${message}`.toLowerCase();
  if (/not[ _-]?found|no such|unknown (id|job|task|bounty|listing)|does not exist/u.test(text)) return "not_found";
  if (/sign[ _-]?in|unauthori[sz]ed|api[ _-]?key|access token|invalid[ _]token|log ?in|forbidden|authenticat|authorization/u.test(text))
    return "auth_required";
  if (/rate[ _-]?limit|too many|quota|throttl/u.test(text)) return "rate_limited";
  if (/already/u.test(text)) return "already_exists";
  if (/invalid|missing|required|validation|must be|unexpected keyword|not (?:one|an option)/u.test(text)) return "invalid_input";
  return "upstream_error";
}

/** An `isError` tool result as a ProtocolError, using the profile's error map and then heuristics. */
export function mapMcpToolError(tool: string, result: McpToolResult, hints: McpErrorHints): ProtocolError {
  const structured = result.structuredContent ?? {};
  const text = toolResultText(result);
  let { code, message } = errorParts(structured);
  if (!code && text.trim().startsWith("{")) {
    try {
      const parsed = errorParts(JSON.parse(text) as Record<string, unknown>);
      code = parsed.code;
      if (parsed.message) message = parsed.message;
    } catch {
      // keep the text
    }
  }
  if (!message) message = text.trim() || `${hints.label} refused ${tool}.`;
  const missing = message.match(MISSING_TOOL);
  if (missing) {
    return new ProtocolError("not_supported", `${hints.label} does not offer ${missing[1]}.`, { details: { tool: missing[1] } });
  }
  const protocolCode = guessCode(code, message, hints);
  const { error: _e, message: _m, ...rest } = structured;
  const short = brief(message);
  const details = {
    ...(code ? { upstream_error: code } : {}),
    ...(short !== message ? { full_message: message.slice(0, 4000) } : {}),
    ...rest,
  };
  message = short;
  if (protocolCode === "auth_required" && hints.help) message = `${message} ${hints.help}`.trim();
  return new ProtocolError(protocolCode, message, { details });
}

/** The code and message of an error body: `{ error: "code", message }` or `{ error: { code, message } }`. */
function errorParts(body: Record<string, unknown>): { code: string; message: string } {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const error = body.error;
  const nested = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  return {
    code: typeof error === "string" ? error : text(nested?.code) || text(nested?.type),
    message: text(body.message) || text(nested?.message) || text(body.error_description),
  };
}

/** The first line of a server's message, capped, so a stack trace or a dump does not become the error text. */
export function brief(message: string, max = 300): string {
  const line = message.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Failures thrown by the SDK client (HTTP status, JSON-RPC error, timeout, process) as ProtocolErrors. */
export function mapMcpTransportError(error: unknown, hints: McpErrorHints): ProtocolError {
  if (isProtocolError(error)) return error;
  const name = typeof error === "object" && error !== null ? (error as { name?: string }).name : undefined;
  const help = hints.help ? ` ${hints.help}` : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new ProtocolError("timeout", `${hints.label} did not answer in time.`, { cause: error });
  }
  if (error instanceof McpError) {
    const message = error.message.replace(/^(MCP error -?\d+:\s*)+/u, "");
    const missing = message.match(/^Tool (\S+) not found/iu);
    if (missing)
      return new ProtocolError("not_supported", `${hints.label} does not offer ${missing[1]}.`, {
        cause: error,
        details: { tool: missing[1] },
      });
    // Some servers answer "Sign in required" with -32001, which the SDK also uses for its own timeouts: the message decides.
    if (/sign[ _-]?in|unauthori[sz]ed|authorization|api[ _-]?key|access token|invalid[ _]token/iu.test(message)) {
      return new ProtocolError("auth_required", `${message}${help}`, { cause: error });
    }
    if (error.code === ErrorCode.RequestTimeout)
      return new ProtocolError("timeout", `${hints.label} did not answer in time.`, { cause: error });
    if (error.code === ErrorCode.InvalidParams) return new ProtocolError("invalid_input", message, { cause: error });
    return new ProtocolError("upstream_error", `${hints.label}: ${message}`, { cause: error });
  }
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401 || error.code === 403)
      return new ProtocolError("auth_required", `${hints.label} refused the credentials.${help}`, { cause: error });
    if (error.code === 429)
      return new ProtocolError("rate_limited", `${hints.label} is rate limiting requests.`, { cause: error, retry_after: 60 });
    return new ProtocolError("upstream_error", `${hints.label} answered ${error.code ?? "with an error"}: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof UnauthorizedError || name === "UnauthorizedError") {
    return new ProtocolError("auth_required", `${hints.label} needs a sign-in.${help}`, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProtocolError("upstream_error", `${hints.label} is unreachable: ${brief(message)}`, { cause: error });
}

export type McpPoolOptions = {
  /** Per-call budget. Default 60 s. */
  timeoutMs?: number;
  transportFactory?: McpTransportFactory;
  log?: Logger;
};

type Entry = { client: Client; ready: Promise<void> };

export class McpClientPool {
  private readonly entries = new Map<string, Entry>();
  private readonly factory: McpTransportFactory;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(options: McpPoolOptions = {}) {
    this.factory = options.transportFactory ?? defaultMcpTransport;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.log = options.log ?? (() => {});
  }

  /** A connected client for the spec, shared by every call with the same key. */
  async client(spec: McpTransportSpec, hints: McpErrorHints): Promise<Client> {
    const key = transportKey(spec);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 200) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) {
          const oldest = this.entries.get(oldestKey);
          this.entries.delete(oldestKey);
          if (oldest) void oldest.client.close().catch(() => {});
        }
      }
      const client = new Client({ name: "work-protocol", version: VERSION });
      const transport = this.factory(spec);
      if (transport instanceof StdioClientTransport && transport.stderr) {
        transport.stderr.on("data", (chunk: Buffer) =>
          this.log("mcp.stderr", { server: hints.label, text: chunk.toString("utf8").slice(0, 500) }),
        );
      }
      const ready = client.connect(transport).catch((error: unknown) => {
        this.entries.delete(key);
        throw mapMcpTransportError(error, hints);
      });
      entry = { client, ready };
      this.entries.set(key, entry);
    }
    await entry.ready;
    return entry.client;
  }

  /** Calls one tool. Transport failures become ProtocolErrors; `isError` results come back as results. */
  async call(
    spec: McpTransportSpec,
    tool: string,
    args: Record<string, unknown>,
    hints: McpErrorHints,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpToolResult> {
    const client = await this.client(spec, hints);
    try {
      return (await client.callTool({ name: tool, arguments: args }, undefined, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeout: options.timeoutMs ?? this.timeoutMs,
      })) as McpToolResult;
    } catch (error) {
      if (!options.signal?.aborted) {
        await this.forget(spec);
      }
      throw mapMcpTransportError(error, hints);
    }
  }

  async listTools(spec: McpTransportSpec, hints: McpErrorHints): Promise<Tool[]> {
    const client = await this.client(spec, hints);
    try {
      return (await client.listTools()).tools;
    } catch (error) {
      await this.forget(spec);
      throw mapMcpTransportError(error, hints);
    }
  }

  /** Drops one connection (after a sign-in, for example). */
  async forget(spec: McpTransportSpec): Promise<void> {
    const key = transportKey(spec);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry) await entry.client.close().catch(() => {});
  }

  async close(): Promise<void> {
    const open = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(open.map(async (entry) => entry.client.close()));
  }
}

/** One pool for the process, shared by every linked server. */
let shared: McpClientPool | undefined;
export function sharedMcpPool(): McpClientPool {
  shared ??= new McpClientPool();
  return shared;
}
