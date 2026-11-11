import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileOAuthProvider, clearOAuth, oauthFile, oauthTokensExist } from "../src/core/oauth.js";
import { loginMcp } from "../src/core/oauthLogin.js";
import { defineMcpConnector } from "../src/core/mcp/index.js";
import { testContext } from "../src/core/conformance.js";

const env = { WORK_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "work-protocol-oauth-")) };

describe("FileOAuthProvider", () => {
  it("stores client information, tokens and the verifier in one file", () => {
    const provider = new FileOAuthProvider("acme", { env, redirectPort: 8791, scope: "jobs" });
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8791/callback");
    expect(provider.clientMetadata).toMatchObject({
      client_name: "Work Protocol",
      redirect_uris: ["http://127.0.0.1:8791/callback"],
      token_endpoint_auth_method: "none",
      scope: "jobs",
    });
    expect(provider.clientInformation()).toBeUndefined();
    provider.saveClientInformation({ client_id: "c1", redirect_uris: [provider.redirectUrl] });
    provider.saveCodeVerifier("v1");
    provider.saveTokens({ access_token: "t1", token_type: "bearer" });
    expect(provider.clientInformation()).toMatchObject({ client_id: "c1" });
    expect(provider.codeVerifier()).toBe("v1");
    expect(provider.tokens()).toMatchObject({ access_token: "t1" });
    expect(oauthTokensExist("acme", env)).toBe(true);
    expect(oauthFile("acme", env)).toContain("oauth");
    const state = provider.state();
    expect(state).toHaveLength(32);
    expect(provider.expectedState).toBe(state);
    provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toMatchObject({ client_id: "c1" });
    expect(clearOAuth("acme", env)).toBe(true);
    expect(clearOAuth("acme", env)).toBe(false);
    expect(oauthTokensExist("acme", env)).toBe(false);
  });
});

/**
 * A server that issues its own bearer tokens: discovery, registration, token and an MCP endpoint that needs one,
 * or with `anonymous` lets clients in without one (its account tools would still need the token).
 */
function fakeAuthServer(options: { anonymous?: boolean } = {}) {
  let base = "";
  const issued = { registrations: 0, tokens: 0, initializes: 0, codes: [] as string[] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      issued.registrations += 1;
      return json(201, { client_id: "client-1", redirect_uris: ["http://127.0.0.1:8792/callback"], token_endpoint_auth_method: "none" });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      if (params.get("grant_type") !== "authorization_code" || !issued.codes.includes(params.get("code") ?? ""))
        return json(400, { error: "invalid_grant" });
      issued.tokens += 1;
      return json(200, { access_token: `tok-${issued.tokens}`, token_type: "bearer", expires_in: 3600, refresh_token: "ref-1" });
    }
    if (url.pathname === "/mcp") {
      const auth = req.headers.authorization ?? "";
      if (!options.anonymous && !/^Bearer tok-\d+$/u.test(auth)) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        res.end("unauthorized");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = body ? (JSON.parse(body) as { method?: string }) : undefined;
      if (message?.method === "initialize") issued.initializes += 1;
      const mcp = new McpServer({ name: "protected", version: "0" });
      mcp.registerTool("my_stuff", { inputSchema: {} }, async () => ({
        content: [{ type: "text", text: '{"items":[{"id":"s1","title":"Mine"}]}' }],
        structuredContent: { items: [{ id: "s1", title: "Mine" }] },
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once("close", () => void transport.close().catch(() => {}));
      await mcp.connect(transport);
      await transport.handleRequest(req, res, message);
      return;
    }
    json(404, { error: "not_found" });
  });
  return {
    issued,
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
          resolve(base);
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe("work login against a server that also lets anonymous clients in", () => {
  const open = fakeAuthServer({ anonymous: true });
  let base = "";
  beforeAll(async () => {
    base = await open.start();
  });
  afterAll(async () => {
    await open.stop();
  });

  it("still runs the sign-in and stores a token", async () => {
    const openEnv = { WORK_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "work-protocol-oauth-open-")) };
    const result = await loginMcp({
      id: "open",
      url: `${base}/mcp`,
      env: openEnv,
      port: 8793,
      timeoutMs: 20_000,
      onAuthorize: async (url) => {
        const state = url.searchParams.get("state");
        const redirect = url.searchParams.get("redirect_uri");
        expect(redirect).toBe("http://127.0.0.1:8793/callback");
        open.issued.codes.push("code-open");
        await fetch(`${redirect}?code=code-open&state=${state}`);
      },
      log: () => {},
    });
    expect(result.tools).toBe(1);
    expect(open.issued.tokens).toBe(1);
    expect(oauthTokensExist("open", openEnv)).toBe(true);
  }, 30_000);
});

describe("work login against an OAuth-protected MCP server", () => {
  const auth = fakeAuthServer();
  let base = "";
  beforeAll(async () => {
    base = await auth.start();
  });
  afterAll(async () => {
    await auth.stop();
  });

  it("registers, authorizes through the callback, exchanges the code and signs in", async () => {
    const result = await loginMcp({
      id: "protected",
      url: `${base}/mcp`,
      env,
      port: 8792,
      timeoutMs: 20_000,
      onAuthorize: async (url) => {
        expect(url.href).toContain(`${base}/authorize`);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        const state = url.searchParams.get("state");
        const redirect = url.searchParams.get("redirect_uri");
        expect(redirect).toBe("http://127.0.0.1:8792/callback");
        auth.issued.codes.push("code-1");
        await fetch(`${redirect}?code=code-1&state=${state}`);
      },
      log: () => {},
    });
    expect(result.tools).toBe(1);
    expect(auth.issued.registrations).toBe(1);
    expect(auth.issued.tokens).toBe(1);
    expect(oauthTokensExist("protected", env)).toBe(true);

    const connector = defineMcpConnector(
      {
        id: "protected",
        name: "Protected",
        description: "d",
        kinds: ["task"],
        transport: { type: "http", url: `${base}/mcp` },
        auth: { type: "oauth", required: true },
        tools: { search: { name: "my_stuff", args: {}, items: "$.items", map: { id: "$.id", title: "$.title" } } },
      },
      { env },
    );
    expect(connector.auth).toMatchObject({ type: "oauth", required: true, help: expect.stringContaining("work login protected") });
    // The connector hands ctx.fetch to its transport, so a real fetch reaches the local server.
    const found = await connector.search!({}, testContext({ credentials: {}, fetch: globalThis.fetch.bind(globalThis) }));
    expect(found.jobs).toEqual([{ id: "s1", kind: "task", title: "Mine" }]);
    // A second signed-in call reuses the connection instead of opening a new one.
    const connections = auth.issued.initializes;
    await connector.search!({}, testContext({ credentials: {}, fetch: globalThis.fetch.bind(globalThis) }));
    expect(auth.issued.initializes).toBe(connections);
    await connector.close?.();
  }, 30_000);

  it("refuses without a sign-in when the profile requires one", async () => {
    clearOAuth("protected", env);
    const connector = defineMcpConnector(
      {
        id: "protected",
        name: "Protected",
        description: "d",
        kinds: ["task"],
        transport: { type: "http", url: `${base}/mcp` },
        auth: { type: "oauth", required: true },
        tools: { search: { name: "my_stuff", args: {}, items: "$.items", map: { id: "$.id", title: "$.title" } } },
      },
      { env },
    );
    await expect(connector.search!({}, testContext({ credentials: {} }))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("work login protected"),
    });
  });
});
