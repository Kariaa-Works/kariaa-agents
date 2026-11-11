import path from "node:path";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { McpClientPool, mapMcpToolError, mapMcpTransportError, toolResultJson, transportKey } from "../src/core/mcpClient.js";
import { isPath, pick, setDeep, template } from "../src/core/mcp/pick.js";
import { createFakeMcp } from "./helpers/fakeMcpServer.js";

describe("pick", () => {
  const doc = {
    jobs: [
      { id: 1, company: { name: "Acme" }, tags: ["a", "b"] },
      { id: 2, company: { name: "Globex" } },
    ],
    total: 2,
  };
  it("reads properties, indexes and fan-outs", () => {
    expect(pick(doc, "$")).toBe(doc);
    expect(pick(doc, "$.total")).toBe(2);
    expect(pick(doc, "$.jobs[1].company.name")).toBe("Globex");
    expect(pick(doc, "$.jobs[*].id")).toEqual([1, 2]);
    expect(pick(doc, "$.jobs[*].company.name")).toEqual(["Acme", "Globex"]);
    expect(pick(doc, "$.jobs[*].tags[*]")).toEqual(["a", "b"]);
    expect(pick(doc, "$.nope.deeper")).toBeUndefined();
    expect(pick(doc, "$.jobs[9]")).toBeUndefined();
    expect(isPath("$.a[0].b")).toBe(true);
    expect(isPath("a.b")).toBe(false);
    expect(() => pick(doc, "a.b")).toThrow(/Not a path/u);
  });
  it("fills templates and sets dotted keys", () => {
    expect(template("https://x.example/${slug}?c=${$.company.name}", { slug: "dev-1", company: { name: "Acme" } })).toBe(
      "https://x.example/dev-1?c=Acme",
    );
    expect(template("${missing}", {})).toBe("");
    const out: Record<string, unknown> = {};
    setDeep(out, "location.text", "Accra");
    setDeep(out, "location.remote", true);
    setDeep(out, "title", "T");
    expect(out).toEqual({ location: { text: "Accra", remote: true }, title: "T" });
  });
});

describe("tool results and errors", () => {
  it("reads structuredContent, then JSON text, then refuses prose", () => {
    expect(toolResultJson({ structuredContent: { a: 1 } }, "X", "t")).toEqual({ a: 1 });
    expect(toolResultJson({ content: [{ type: "text", text: '{"jobs":[1]}' }] }, "X", "t")).toEqual({ jobs: [1] });
    expect(toolResultJson({ content: [{ type: "text", text: "[1,2]" }] }, "X", "t")).toEqual({ items: [1, 2] });
    expect(() => toolResultJson({ content: [{ type: "text", text: "# Markdown" }] }, "X", "t")).toThrow(/text, not JSON/u);
  });

  it("maps tool errors with the profile map and heuristics", () => {
    const hints = { label: "Board", help: "Get a key at x.", errors: { weird_code: "wrong_stage" as const } };
    expect(mapMcpToolError("t", { isError: true, structuredContent: { error: "weird_code", message: "m" } }, hints).code).toBe(
      "wrong_stage",
    );
    expect(mapMcpToolError("t", { isError: true, structuredContent: { error: "job_not_found", message: "No job" } }, hints).code).toBe(
      "not_found",
    );
    const nested = mapMcpToolError(
      "t",
      { isError: true, content: [{ type: "text", text: '{"error":{"code":"job_not_found","message":"That job is gone."}}' }] },
      hints,
    );
    expect(nested).toMatchObject({ code: "not_found", message: "That job is gone.", details: { upstream_error: "job_not_found" } });
    expect(
      mapMcpToolError("t", { isError: true, structuredContent: { error: { code: "weird_code", message: "Not now" } } }, hints).code,
    ).toBe("wrong_stage");
    const auth = mapMcpToolError(
      "t",
      { isError: true, content: [{ type: "text", text: "Missing or invalid Authorization header." }] },
      hints,
    );
    expect(auth.code).toBe("auth_required");
    expect(auth.message).toContain("Get a key at x.");
    expect(mapMcpToolError("t", { isError: true, content: [{ type: "text", text: "Too many requests" }] }, hints).code).toBe(
      "rate_limited",
    );
    expect(
      mapMcpToolError(
        "t",
        { isError: true, content: [{ type: "text", text: "2 validation errors: keyword Missing required argument" }] },
        hints,
      ).code,
    ).toBe("invalid_input");
    expect(
      mapMcpToolError("t", { isError: true, content: [{ type: "text", text: "MCP error -32602: Tool nope not found" }] }, hints),
    ).toMatchObject({ code: "not_supported", details: { tool: "nope" } });
    expect(
      mapMcpToolError(
        "t",
        { isError: true, content: [{ type: "text", text: '{"error":"invalid_token","error_description":"No authorization provided"}' }] },
        hints,
      ).code,
    ).toBe("auth_required");
    expect(mapMcpToolError("t", { isError: true, content: [{ type: "text", text: "Something odd" }] }, hints)).toMatchObject({
      code: "upstream_error",
      message: "Something odd",
    });
  });

  it("maps transport failures", () => {
    const hints = { label: "Board", help: "Run work login board." };
    expect(mapMcpTransportError(new StreamableHTTPError(401, "Unauthorized"), hints)).toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("work login"),
    });
    expect(mapMcpTransportError(new StreamableHTTPError(429, "slow down"), hints)).toMatchObject({ code: "rate_limited", retry_after: 60 });
    expect(mapMcpTransportError(new McpError(ErrorCode.RequestTimeout, "timed out"), hints).code).toBe("timeout");
    expect(mapMcpTransportError(new McpError(-32001, "Sign in required"), hints).code).toBe("auth_required");
    expect(mapMcpTransportError(new McpError(ErrorCode.InvalidParams, "Tool x not found"), hints).code).toBe("not_supported");
    expect(mapMcpTransportError(Object.assign(new Error("nope"), { name: "UnauthorizedError" }), hints).code).toBe("auth_required");
    expect(mapMcpTransportError(new TypeError("fetch failed"), hints)).toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("unreachable"),
    });
  });

  it("keys transports by url, headers and provider", () => {
    expect(transportKey({ type: "http", url: "https://a", headers: { authorization: "Bearer x" } })).not.toBe(
      transportKey({ type: "http", url: "https://a" }),
    );
    expect(transportKey({ type: "http", url: "https://a" })).toBe(transportKey({ type: "http", url: "https://a", headers: {} }));
    expect(transportKey({ type: "stdio", command: "node", args: ["s.mjs"] })).toContain("stdio");
  });
});

describe("McpClientPool", () => {
  it("shares one connection per credential and reports isError results", async () => {
    const fake = createFakeMcp({ ping: () => ({ ok: true }), secret: () => ({ fine: true }) }, { requireAuth: ["secret"] });
    const pool = new McpClientPool({ transportFactory: fake.transportFactory });
    const anon = { type: "http" as const, url: "https://fake.example/mcp" };
    const keyed = { type: "http" as const, url: "https://fake.example/mcp", headers: { authorization: "Bearer k" } };
    const hints = { label: "Fake" };
    await Promise.all([pool.call(anon, "ping", {}, hints), pool.call(anon, "ping", {}, hints)]);
    expect(fake.connections).toBe(1);
    const refused = await pool.call(anon, "secret", {}, hints);
    expect(refused.isError).toBe(true);
    const allowed = await pool.call(keyed, "secret", {}, hints);
    expect(allowed.structuredContent).toEqual({ fine: true });
    expect(fake.connections).toBe(2);
    expect((await pool.listTools(anon, hints)).map((t) => t.name).sort()).toEqual(["ping", "secret"]);
    await pool.forget(anon);
    await pool.call(anon, "ping", {}, hints);
    expect(fake.connections).toBe(3);
    await pool.close();
  });

  it("talks to a stdio server", async () => {
    const pool = new McpClientPool();
    const spec = {
      type: "stdio" as const,
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, "helpers", "stdio-server.mjs")],
      env: { STDIO_FAKE_TOKEN: "t0k" },
    };
    const hints = { label: "stdio fake" };
    const tools = await pool.listTools(spec, hints);
    expect(tools.map((t) => t.name).sort()).toEqual(["list_bounties", "whoami_env"]);
    const result = await pool.call(spec, "list_bounties", { limit: 1 }, hints);
    expect(toolResultJson(result, "stdio", "list_bounties")).toMatchObject({ bounties: [{ id: "b1" }] });
    const env = await pool.call(spec, "whoami_env", {}, hints);
    expect(env.structuredContent).toEqual({ token: "t0k" });
    await pool.close();
  }, 30_000);
});
