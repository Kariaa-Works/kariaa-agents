/**
 * One JSON request through ctx.fetch, with HTTP failures turned into ProtocolErrors.
 * Code connectors that talk REST use this instead of handling statuses one by one.
 */
import type { ConnectorContext } from "./connector.js";
import { ProtocolError, toProtocolError } from "./errors.js";
import { USER_AGENT } from "./version.js";

export type JsonRequest = {
  /** Shown in error messages. */
  label: string;
  connector: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** Sent as JSON when it is an object; as-is when it is a string or bytes. */
  body?: unknown;
  /** What a missing or refused credential should say. */
  authHelp?: string;
  /** The body is not JSON: hand it back as text. */
  text?: boolean;
};

/** Reads the error text a JSON API sends with a failure, when there is one. */
async function errorText(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    if (!text) return undefined;
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      // JSON:API bodies carry their messages in errors[].detail or errors[].title.
      const first = Array.isArray(body.errors) ? (body.errors[0] as Record<string, unknown> | undefined) : undefined;
      const nested = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>).message : undefined;
      const message = [body.message, body.error, nested, body.error_description, body.detail, first?.detail, first?.title].find(
        (value) => typeof value === "string" && value.trim(),
      );
      return typeof message === "string" ? message : text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return undefined;
  }
}

/**
 * Seconds to wait when a response says the caller is over a rate limit, else undefined. Some APIs (GitHub) answer
 * 403 rather than 429, with `x-ratelimit-remaining: 0`, a `retry-after`, or a body that says so.
 */
async function rateLimitWait(response: Response): Promise<number | undefined> {
  const retry = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  let limited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
  if (!limited && response.status === 403)
    limited = /rate.?limit/iu.test(
      await response
        .clone()
        .text()
        .catch(() => ""),
    );
  if (!limited) return undefined;
  if (Number.isFinite(retry) && retry > 0) return retry;
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  return 60;
}

export async function fetchJson<T = unknown>(ctx: ConnectorContext, url: string | URL, request: JsonRequest): Promise<T> {
  const { label, connector } = request;
  const bodyIsRaw = typeof request.body === "string" || request.body instanceof Uint8Array;
  let response: Response;
  try {
    response = await ctx.fetch(String(url), {
      method: request.method ?? (request.body === undefined ? "GET" : "POST"),
      headers: {
        accept: request.text ? "*/*" : "application/json",
        "user-agent": USER_AGENT,
        ...(request.body !== undefined && !bodyIsRaw ? { "content-type": "application/json" } : {}),
        ...request.headers,
      },
      ...(request.body !== undefined ? { body: bodyIsRaw ? (request.body as string | Uint8Array) : JSON.stringify(request.body) } : {}),
      signal: ctx.signal,
    });
  } catch (error) {
    throw toProtocolError(error, connector);
  }
  if (response.status === 429 || response.status === 403) {
    const wait = await rateLimitWait(response);
    if (wait !== undefined)
      throw new ProtocolError("rate_limited", `${label} is rate limiting requests.`, { connector, retry_after: wait });
  }
  if (response.status === 401 || response.status === 403) {
    const detail = await errorText(response);
    throw new ProtocolError(
      "auth_required",
      [`${label} refused the credential (${response.status}).`, request.authHelp, detail].filter(Boolean).join(" "),
      {
        connector,
        details: { status: response.status },
      },
    );
  }
  if (response.status === 404) {
    throw new ProtocolError("not_found", `${label} has nothing at that id.`, { connector, details: { status: 404 } });
  }
  if (!response.ok) {
    const detail = await errorText(response);
    throw new ProtocolError(
      response.status >= 500 ? "upstream_error" : "invalid_input",
      `${label} answered ${response.status}${detail ? `: ${detail}` : "."}`,
      { connector, details: { status: response.status } },
    );
  }
  if (request.text) return (await response.text()) as T;
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ProtocolError("upstream_error", `${label} did not answer with JSON.`, { connector, cause: error });
  }
}
