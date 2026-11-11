import { describe, expect, it } from "vitest";
import { fixtureFetch, jsonResponse, testContext } from "../src/core/conformance.js";
import { fetchJson } from "../src/core/http.js";

const call = (response: Response | unknown, authHelp = "Keys at https://acme.example/keys") =>
  fetchJson(testContext({ fetch: fixtureFetch(() => response) }), "https://api.acme.example/jobs", {
    label: "Acme",
    connector: "acme",
    authHelp,
  });

describe("fetchJson", () => {
  it("returns the JSON body", async () => {
    await expect(call({ jobs: [1] })).resolves.toEqual({ jobs: [1] });
  });

  it("maps refused credentials to auth_required with the help and the server's message", async () => {
    await expect(call(jsonResponse({ message: "Bad token" }, 401))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("Keys at https://acme.example/keys"),
    });
    await expect(call(jsonResponse({ errors: [{ status: 403, title: "Forbidden", detail: "Token revoked" }] }, 403))).rejects.toMatchObject(
      {
        code: "auth_required",
        message: expect.stringContaining("Token revoked"),
      },
    );
  });

  it("treats a 403 that says it is a rate limit as rate_limited, with the wait from the headers", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 120;
    const github = new Response(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4." }), {
      status: 403,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    });
    const error = await call(github).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "rate_limited" });
    const wait =
      (error as { details?: { retry_after?: number }; retry_after?: number }).retry_after ??
      (error as { details?: { retry_after?: number } }).details?.retry_after;
    expect(wait).toBeGreaterThan(100);
    expect(wait).toBeLessThanOrEqual(121);
    await expect(call(jsonResponse({ message: "You have exceeded a secondary rate limit." }, 403))).rejects.toMatchObject({
      code: "rate_limited",
    });
    await expect(call(new Response("slow down", { status: 429, headers: { "retry-after": "7" } }))).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("maps 404 and server errors", async () => {
    await expect(call(jsonResponse({ error: "nope" }, 404))).rejects.toMatchObject({ code: "not_found" });
    await expect(call(jsonResponse({ error: "boom" }, 502))).rejects.toMatchObject({ code: "upstream_error" });
  });
});
