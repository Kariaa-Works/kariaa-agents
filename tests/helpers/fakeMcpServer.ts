/**
 * An in-memory MCP server for connector tests. Each tool is a handler that
 * returns JSON (sent as structuredContent), `{ text }` (sent as text only),
 * `{ error, message }` (an isError result), or throws.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpTransportFactory, McpTransportSpec } from "../../src/core/mcpClient.js";

export type FakeCall = { tool: string; args: Record<string, unknown>; headers: Record<string, string> };
export type FakeToolResult =
  Record<string, unknown> | unknown[] | { text: string } | { error: string; message: string; [key: string]: unknown } | string;
export type FakeHandler = (
  args: Record<string, unknown>,
  meta: { headers: Record<string, string>; signedIn: boolean },
) => FakeToolResult | Promise<FakeToolResult>;

export type FakeMcpOptions = {
  /** Tools that answer `{ error: "sign_in_required" }` without a bearer header. */
  requireAuth?: string[];
  /** Which bearer tokens count as signed in. Default: any. */
  validTokens?: string[];
};

export function createFakeMcp(tools: Record<string, FakeHandler>, options: FakeMcpOptions = {}) {
  const calls: FakeCall[] = [];
  let connections = 0;

  function build(headers: Record<string, string>): McpServer {
    const server = new McpServer({ name: "fake", version: "0" });
    const token = headers.authorization?.replace(/^Bearer\s+/iu, "");
    const signedIn = Boolean(token) && (!options.validTokens || options.validTokens.includes(token!));
    for (const [name, handler] of Object.entries(tools)) {
      server.registerTool(name, { inputSchema: z.object({}).passthrough() }, async (raw: Record<string, unknown>) => {
        const args = raw ?? {};
        calls.push({ tool: name, args, headers });
        if (options.requireAuth?.includes(name) && !signedIn) {
          return {
            isError: true,
            content: [{ type: "text", text: "Sign in first." }],
            structuredContent: { error: "sign_in_required", message: "Sign in first." },
          } as CallToolResult;
        }
        let out: FakeToolResult;
        try {
          out = await handler(args, { headers, signedIn });
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          } as CallToolResult;
        }
        if (typeof out === "string") return { content: [{ type: "text", text: out }] } as CallToolResult;
        if (Array.isArray(out)) return { content: [{ type: "text", text: JSON.stringify(out) }] } as CallToolResult;
        if ("text" in out && typeof out.text === "string" && Object.keys(out).length === 1)
          return { content: [{ type: "text", text: out.text }] } as CallToolResult;
        if ("error" in out && typeof out.error === "string") {
          return {
            isError: true,
            content: [{ type: "text", text: String(out.message ?? out.error) }],
            structuredContent: out as Record<string, unknown>,
          } as CallToolResult;
        }
        return {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out as Record<string, unknown>,
        } as CallToolResult;
      });
    }
    return server;
  }

  const transportFactory: McpTransportFactory = (spec: McpTransportSpec) => {
    const headers = spec.type === "http" ? { ...(spec.headers ?? {}) } : {};
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    connections += 1;
    // An OAuth provider's stored tokens count as the bearer, the way the real transport sends them.
    void (async () => {
      if (spec.type === "http" && spec.authProvider && !headers.authorization) {
        const tokens = await spec.authProvider.tokens();
        if (tokens?.access_token) headers.authorization = `Bearer ${tokens.access_token}`;
      }
      await build(headers).connect(serverTransport);
    })();
    return clientTransport;
  };

  return {
    transportFactory,
    calls,
    get connections() {
      return connections;
    },
    lastCall: (tool: string) => [...calls].reverse().find((c) => c.tool === tool),
  };
}
