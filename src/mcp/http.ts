/**
 * The MCP server over Streamable HTTP on plain Node http. Stateless: a fresh
 * McpServer and transport per request. Single tenant: credentials come from
 * the environment, so protect the port with WORK_HTTP_TOKEN when it is reachable.
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { WorkProtocol } from "../core/router.js";
import { VERSION } from "../core/version.js";
import { createWorkMcpServer } from "./server.js";

export type ProtocolResolution = { ok: true; protocol: WorkProtocol } | { ok: false; status: number; error: string; message: string };

export type HttpServerOptions = {
  protocol: WorkProtocol;
  /**
   * Per-caller protocol. When set, Authorization is a person's kra_ key and
   * the shared `token` is not required. Local `work serve --token` leaves this unset.
   */
  resolveProtocol?: (authorization: string | undefined) => Promise<ProtocolResolution>;
  /** Bearer token every request must carry when resolveProtocol is unset. */
  token?: string;
  /** Hosts allowed in the Host header (DNS-rebinding protection). Default: loopback names with the port when bound to loopback. */
  allowedHosts?: string[];
  maxBodyBytes?: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

const MAX_BODY = 2 * 1024 * 1024;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
};

const OAUTH_ISSUER = process.env.WORK_OAUTH_ISSUER?.trim() || "https://agent.kariaa.com";
const OAUTH_SITE_URL = process.env.WORK_SITE_URL?.trim() || "https://www.kariaa.com";
const OAUTH_SCOPES = ["datahouse:read", "datahouse:write"];

function isJsonRpcPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return (
      value.length > 0 &&
      value.every((item) => Boolean(item && typeof item === "object" && (item as { jsonrpc?: unknown }).jsonrpc === "2.0"))
    );
  }
  return Boolean(value && typeof value === "object" && (value as { jsonrpc?: unknown }).jsonrpc === "2.0");
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS, ...headers });
  res.end(JSON.stringify(body));
}

function bearerMatches(authorization: string | string[] | undefined, expectedToken: string): boolean {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header || !expectedToken) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${expectedToken}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage, max: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > max) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHttpServer(options: HttpServerOptions): http.Server {
  const { protocol } = options;
  const max = options.maxBodyBytes ?? MAX_BODY;
  const log = options.log ?? (() => {});
  let allowedHosts = options.allowedHosts;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    try {
      if (method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      if (url.pathname === "/healthz" || url.pathname === "/") {
        json(res, 200, {
          ok: true,
          name: "work-protocol",
          version: VERSION,
          mcp: "/mcp",
          connectors: protocol.connectors().map((c) => c.id),
        });
        return;
      }
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
        url.pathname === "/.well-known/oauth-authorization-server/mcp/auth" ||
        url.pathname === "/.well-known/openid-configuration"
      ) {
        const site = OAUTH_SITE_URL.replace(/\/$/u, "");
        const issuer = OAUTH_ISSUER.replace(/\/$/u, "");
        json(res, 200, {
          issuer,
          authorization_endpoint: `${site}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          registration_endpoint: `${issuer}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
          scopes_supported: OAUTH_SCOPES,
          service_documentation: `${site}/datahouse/mcp`,
        });
        return;
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
        const hostHeader = req.headers.host || "localhost";
        const origin = `${proto}://${hostHeader}`;
        const suffix = url.pathname.slice("/.well-known/oauth-protected-resource".length) || "/mcp";
        const issuer = OAUTH_ISSUER.replace(/\/$/u, "");
        const site = OAUTH_SITE_URL.replace(/\/$/u, "");
        json(res, 200, {
          resource: `${origin}${suffix}`,
          authorization_servers: [issuer],
          scopes_supported: OAUTH_SCOPES,
          bearer_methods_supported: ["header"],
          resource_name: "Kariaa Work Protocol",
          resource_documentation: `${site}/datahouse/mcp`,
        });
        return;
      }
      if (url.pathname !== "/mcp" && url.pathname !== "/mcp/auth") {
        json(res, 404, { error: "not_found", message: "The MCP endpoint is POST /mcp." });
        return;
      }
      if (method !== "POST") {
        json(
          res,
          405,
          { error: "method_not_allowed", message: "Use POST /mcp (stateless; no SSE stream to open)." },
          { Allow: "POST, OPTIONS" },
        );
        return;
      }
      const raw = await readBody(req, max);
      if (raw === null) {
        json(res, 413, { error: "too_large", message: `The body is over ${Math.round(max / 1_048_576)} MB. Send large files by url.` });
        return;
      }
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        json(res, 400, { error: "invalid_input", message: "The body is not JSON." });
        return;
      }
      let protocolForRequest = protocol;
      if (options.resolveProtocol) {
        const header = req.headers.authorization;
        const authValue = Array.isArray(header) ? header[0] : header;
        if (!authValue && (url.pathname === "/mcp/auth" || !isJsonRpcPayload(parsed))) {
          const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
          const hostHeader = req.headers.host || "localhost";
          const resourceMeta = `${proto}://${hostHeader}/.well-known/oauth-protected-resource${url.pathname}`;
          json(
            res,
            401,
            { error: "auth_required", message: "Send Authorization: Bearer kra_… from https://www.kariaa.com/datahouse/connect." },
            { "WWW-Authenticate": `Bearer realm="work-protocol", resource_metadata="${resourceMeta}"` },
          );
          return;
        }
        const resolved = await options.resolveProtocol(authValue);
        if (!resolved.ok) {
          json(res, resolved.status, { error: resolved.error, message: resolved.message });
          return;
        }
        protocolForRequest = resolved.protocol;
      } else if (options.token) {
        if (!bearerMatches(req.headers.authorization, options.token)) {
          json(
            res,
            401,
            { error: "auth_required", message: "Send Authorization: Bearer <WORK_HTTP_TOKEN>." },
            { "WWW-Authenticate": 'Bearer realm="work-protocol"' },
          );
          return;
        }
      }
      const mcp = createWorkMcpServer(protocolForRequest, { allowLocalFiles: false });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        ...(allowedHosts?.length ? { enableDnsRebindingProtection: true, allowedHosts } : {}),
      });
      res.once("close", () => {
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      });
      for (const [key, value] of Object.entries(CORS)) res.setHeader(key, value);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (error) {
      log("http.failed", { message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) json(res, 500, { error: "upstream_error", message: "The server failed to handle the request." });
      else res.end();
    }
  });

  server.once("listening", () => {
    if (allowedHosts) return;
    const address = server.address();
    if (!address || typeof address === "string") return;
    const loopback = address.address === "127.0.0.1" || address.address === "::1" || address.address === "::ffff:127.0.0.1";
    if (loopback) allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`, `[::1]:${address.port}`];
  });

  return server;
}

export type ListenOptions = HttpServerOptions & { port?: number; host?: string };

/** Starts listening and resolves with the bound address and a closer. */
export async function listen(
  options: ListenOptions,
): Promise<{ server: http.Server; host: string; port: number; close: () => Promise<void> }> {
  const server = createHttpServer(options);
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : (options.port ?? 8787);
  return {
    server,
    host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
