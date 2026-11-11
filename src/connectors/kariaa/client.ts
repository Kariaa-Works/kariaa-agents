/**
 * Kariaa's MCP server through the shared client pool, with Kariaa's own
 * error vocabulary mapped onto ProtocolErrors.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ProtocolError } from "../../core/errors.js";
import { inWorkTerms } from "./map.js";
import {
  McpClientPool,
  mapMcpTransportError,
  type McpErrorHints,
  type McpToolResult,
  type McpTransportFactory,
  type McpTransportSpec,
} from "../../core/mcpClient.js";

export const KARIAA_MCP_URL = "https://agent.kariaa.com/mcp";
export const KARIAA_KEY_HELP =
  "Set KARIAA_API_KEY to a key from https://www.kariaa.com/datahouse/connect. In Claude, ChatGPT or Perplexity you can instead sign in with Kariaa through https://agent.kariaa.com/mcp/auth.";

/** Kept for tests: builds a transport from the endpoint and the key in use. */
export type TransportFactory = (options: { url: string; key: string | undefined }) => Transport;

export type KariaaClientOptions = {
  /** Defaults to https://agent.kariaa.com/mcp. */
  url?: string;
  /** Replaced in tests with an in-memory transport. */
  transportFactory?: TransportFactory;
  /** Per-call budget. Default 60 s. */
  timeoutMs?: number;
};

export type CallOptions = { key?: string; signal?: AbortSignal; timeoutMs?: number };

const HINTS: McpErrorHints = { label: "Kariaa", help: KARIAA_KEY_HELP };

const INVALID_INPUT = new Set([
  "answers_missing",
  "answer_not_an_option",
  "kind_not_allowed",
  "mime_not_allowed",
  "text_not_allowed",
  "too_large",
  "too_many_files",
  "looks_like_gibberish",
  "file_too_small",
  "path_mismatch",
  // A challenge task checks the answer as it arrives; the message says what to fix.
  "challenge_failed",
]);

function secondsToUtcMidnight(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.round((next.getTime() - now) / 1000));
}

/** Kariaa's tool-level error codes as ProtocolErrors. */
export function mapToolError(tool: string, result: McpToolResult): ProtocolError {
  const structured = result.structuredContent ?? {};
  const code = typeof structured.error === "string" ? structured.error : "unknown";
  const text = result.content?.find((c) => c.type === "text")?.text;
  const message = inWorkTerms(typeof structured.message === "string" ? structured.message : text || `Kariaa refused ${tool}.`);
  const { error: _error, message: _message, ...rest } = structured;
  const details = { kariaa_error: code, ...rest };

  if (code === "sign_in_required") return new ProtocolError("auth_required", KARIAA_KEY_HELP, { details });
  if (INVALID_INPUT.has(code) || code.startsWith("content_not_")) return new ProtocolError("invalid_input", message, { details });
  if (code === "duplicate_sample" || code === "payout_pending") return new ProtocolError("already_exists", message, { details });
  if (code === "below_minimum" || code === "insufficient_balance" || code === "nothing_to_pay")
    return new ProtocolError("not_ready", message, { details });
  if (code === "method_not_supported" || code === "destination_required" || code === "destination_invalid")
    return new ProtocolError("invalid_input", message, { details });
  if (code === "already_submitted") return new ProtocolError("wrong_stage", message, { details: { ...details, stage: "in_review" } });
  if (code === "not_unlocked") return new ProtocolError("wrong_stage", message, { details: { ...details, stage: "applied" } });
  if (code === "not_enough_files" || code === "profile_incomplete") return new ProtocolError("not_ready", message, { details });
  // Submitting with nothing in comes back as a plain submit_failed; it is the same "add work first" as not_enough_files.
  if (code === "submit_failed" && /before submitting/iu.test(message)) return new ProtocolError("not_ready", message, { details });
  if (code.endsWith("_not_found")) return new ProtocolError("not_found", message, { details });
  if (code === "search_limit") return new ProtocolError("rate_limited", message, { details, retry_after: 3600 });
  if (code === "daily_write_limit") return new ProtocolError("rate_limited", message, { details, retry_after: secondsToUtcMidnight() });
  // The SDK answers an unknown tool as an error result, not a protocol error.
  const missingTool = code === "unknown" ? message.match(/Tool (\S+) not found/iu) : null;
  if (missingTool) {
    return new ProtocolError("not_supported", `Kariaa's server does not offer ${missingTool[1]} yet.`, {
      details: { tool: missingTool[1] },
    });
  }
  return new ProtocolError("upstream_error", message, { details });
}

/** Failures thrown by the SDK client as ProtocolErrors, worded for Kariaa. */
export function mapTransportError(error: unknown): ProtocolError {
  return mapMcpTransportError(error, HINTS);
}

export class KariaaClientPool {
  readonly url: string;
  private readonly pool: McpClientPool;
  private readonly timeoutMs: number;

  constructor(options: KariaaClientOptions = {}) {
    this.url = options.url ?? KARIAA_MCP_URL;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    const factory = options.transportFactory;
    const transportFactory: McpTransportFactory | undefined = factory
      ? (spec: McpTransportSpec) =>
          factory({
            url: spec.type === "http" ? spec.url : this.url,
            key: spec.type === "http" ? spec.headers?.authorization?.replace(/^Bearer\s+/iu, "") : undefined,
          })
      : undefined;
    this.pool = new McpClientPool({ timeoutMs: this.timeoutMs, ...(transportFactory ? { transportFactory } : {}) });
  }

  private spec(key: string | undefined): McpTransportSpec {
    return { type: "http", url: this.url, headers: key ? { authorization: `Bearer ${key}` } : {} };
  }

  /** Calls one tool and returns its structuredContent. Throws ProtocolError. */
  async call(tool: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<Record<string, unknown>> {
    const result = await this.pool.call(this.spec(options.key), tool, args, HINTS, {
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    });
    if (result.isError) throw mapToolError(tool, result);
    return result.structuredContent ?? {};
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
