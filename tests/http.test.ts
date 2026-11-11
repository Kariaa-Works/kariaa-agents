import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobCache } from "../src/core/jobCache.js";
import { WorkProtocol } from "../src/core/router.js";
import { listen } from "../src/mcp/http.js";
import { WORK_MCP_TOOLS } from "../src/mcp/server.js";
import { fullStageConnector, searchOnlyConnector } from "./helpers/fakeConnectors.js";

const INIT = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

describe("MCP over HTTP", () => {
  const protocol = new WorkProtocol({
    connectors: [fullStageConnector(), searchOnlyConnector()],
    env: {},
    cache: new JobCache(),
    allowLocalFiles: false,
  });
  let base = "";
  let close: () => Promise<void>;
  let closeTokened: () => Promise<void>;
  let tokened = "";

  beforeAll(async () => {
    const open = await listen({ protocol, port: 0, host: "127.0.0.1", maxBodyBytes: 4096 });
    base = `http://127.0.0.1:${open.port}`;
    close = open.close;
    const guarded = await listen({ protocol, port: 0, host: "127.0.0.1", token: "s3cret" });
    tokened = `http://127.0.0.1:${guarded.port}`;
    closeTokened = guarded.close;
  });

  afterAll(async () => {
    await close();
    await closeTokened();
  });

  it("serves the official client end to end", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(WORK_MCP_TOOLS.length);
    const result = (await client.callTool({ name: "search_jobs", arguments: { query: "electrician" } })) as {
      structuredContent?: { jobs: unknown[] };
    };
    expect(result.structuredContent?.jobs.length).toBeGreaterThan(0);
    const paths = (await client.callTool({ name: "add_work", arguments: { application_id: "fake-tasks:a1", file: { path: "C:/x" } } })) as {
      isError?: boolean;
    };
    expect(paths.isError).toBe(true);
    await client.close();
  });

  it("answers health, 404, 405 and preflight", async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, connectors: ["fake-tasks", "fake-board"] });
    const get = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toContain("POST");
    const del = await fetch(`${base}/mcp`, { method: "DELETE" });
    expect(del.status).toBe(405);
    const missing = await fetch(`${base}/other`);
    expect(missing.status).toBe(404);
    const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Mcp-Protocol-Version");
  });

  it("rejects a POST without the accept header, bad JSON and oversize bodies", async () => {
    const noAccept = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(INIT),
    });
    expect(noAccept.status).toBe(406);
    const badJson = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{nope",
    });
    expect(badJson.status).toBe(400);
    const big = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ ...INIT, params: { pad: "x".repeat(5000) } }),
    });
    expect(big.status).toBe(413);
  });

  it("requires the bearer token when one is set", async () => {
    const denied = await fetch(`${tokened}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(INIT),
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Bearer");
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${tokened}/mcp`), { requestInit: { headers: { authorization: "Bearer s3cret" } } }),
    );
    expect((await client.listTools()).tools).toHaveLength(WORK_MCP_TOOLS.length);
    await client.close();
  });
});
