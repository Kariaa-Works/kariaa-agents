export const ERROR_CODES = [
  /** The connector or job does not offer this stage. */
  "not_supported",
  "not_found",
  /** Sign in or set the connector's credential first. */
  "auth_required",
  "rate_limited",
  /** The input is wrong; `details` says how. */
  "invalid_input",
  /** Do something first: complete the profile, add more files. */
  "not_ready",
  /** Too late or not yet unlocked; `details.stage` says where the application is. */
  "wrong_stage",
  /** It is already there; for a duplicate file, `details` names the existing one. */
  "already_exists",
  "timeout",
  "upstream_error",
  /** The key or the person's settings don't allow this action. */
  "forbidden",
  /** The person asked to approve this action first; details.approve_url is where. Repeat the same call once approved. */
  "approval_required",
  /** The person does this step on the platform's site; details.handoff says where and what to do. */
  "handoff_required",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ProtocolErrorOptions = {
  connector?: string;
  details?: Record<string, unknown>;
  retry_after?: number;
  cause?: unknown;
};

/** The one error type the protocol raises. Tools never throw it across MCP; they return it as a result. */
export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly connector: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly retry_after: number | undefined;

  constructor(code: ErrorCode, message: string, options: ProtocolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProtocolError";
    this.code = code;
    this.connector = options.connector;
    this.details = options.details;
    this.retry_after = options.retry_after;
  }

  /** The same error attributed to a connector (kept if already set). */
  from(connector: string): ProtocolError {
    if (this.connector) return this;
    return new ProtocolError(this.code, this.message, {
      connector,
      details: this.details,
      retry_after: this.retry_after,
      cause: this.cause,
    });
  }

  /** The object a tool result or the CLI prints: `error`, `message`, and the rest under their own keys. */
  toJSON(): { error: ErrorCode; message: string; connector?: string; retry_after?: number; details?: Record<string, unknown> } {
    return {
      error: this.code,
      message: this.message,
      ...(this.connector ? { connector: this.connector } : {}),
      ...(this.retry_after !== undefined ? { retry_after: this.retry_after } : {}),
      ...(this.details && Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}

export function isProtocolError(value: unknown): value is ProtocolError {
  return (
    value instanceof ProtocolError ||
    (typeof value === "object" && value !== null && (value as { name?: string }).name === "ProtocolError" && "code" in value)
  );
}

function isAbortLike(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Any thrown value as a ProtocolError: aborts become `timeout`, the rest `upstream_error`. */
export function toProtocolError(error: unknown, connector?: string): ProtocolError {
  if (isProtocolError(error)) return connector ? error.from(connector) : error;
  if (isAbortLike(error)) {
    return new ProtocolError("timeout", "The source did not answer in time.", { connector, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProtocolError("upstream_error", message || "The source failed.", { connector, cause: error });
}
