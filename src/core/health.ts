/**
 * Whether a platform is answering. Three platform failures in a row (timeouts, outages, broken answers) take
 * it out of searches across the catalog; while it is out, one search every few minutes tries it again, and
 * the first answer puts it back. A refused key or a rate limit is about one person's account, not the
 * platform, so those never count.
 *
 * One instance is shared by every request a server handles, so one person's failed search spares the next.
 */
import type { ErrorCode } from "./errors.js";

export type HealthStatus = "ok" | "down";

export type HealthReport = {
  connector: string;
  status: HealthStatus;
  /** Platform failures in a row. */
  failures: number;
  last_ok?: string;
  last_failure?: { at: string; code: ErrorCode };
};

/** Codes that say nothing about the platform itself. */
const NOT_THE_PLATFORM: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "auth_required",
  "forbidden",
  "rate_limited",
  "invalid_input",
  "not_found",
  "not_supported",
  "approval_required",
  "handoff_required",
  "already_exists",
  "not_ready",
  "wrong_stage",
]);

type Entry = { failures: number; lastOk?: number; lastFailure?: { at: number; code: ErrorCode }; nextProbe?: number };

export type ConnectorHealthOptions = {
  /** Failures in a row that take a platform out. Default 3. */
  threshold?: number;
  /** How often a platform that is out gets one try. Default 10 minutes. */
  probeEveryMs?: number;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
};

export class ConnectorHealth {
  private readonly entries = new Map<string, Entry>();
  private readonly threshold: number;
  private readonly probeEveryMs: number;
  private readonly now: () => number;
  private readonly log: (event: string, data: Record<string, unknown>) => void;

  constructor(options: ConnectorHealthOptions = {}) {
    this.threshold = options.threshold ?? 3;
    this.probeEveryMs = options.probeEveryMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { failures: 0 };
      this.entries.set(id, e);
    }
    return e;
  }

  /** Records an answer. */
  ok(id: string): void {
    const e = this.entry(id);
    if (e.failures >= this.threshold) this.log("health.up", { connector: id, after_failures: e.failures });
    e.failures = 0;
    e.lastOk = this.now();
    delete e.nextProbe;
  }

  /** Records a failure; ignored when the code is about the account rather than the platform. */
  failed(id: string, code: ErrorCode): void {
    if (NOT_THE_PLATFORM.has(code)) return;
    const e = this.entry(id);
    e.failures += 1;
    e.lastFailure = { at: this.now(), code };
    if (e.failures === this.threshold) this.log("health.down", { connector: id, code });
    if (e.failures >= this.threshold) e.nextProbe = this.now() + this.probeEveryMs;
  }

  status(id: string): HealthStatus {
    return (this.entries.get(id)?.failures ?? 0) >= this.threshold ? "down" : "ok";
  }

  /**
   * Whether a catalog search should ask this platform now: yes when it is up, and for a platform that is out,
   * once per probe interval (this call takes the probe).
   */
  shouldAsk(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.failures < this.threshold) return true;
    if ((e.nextProbe ?? 0) > this.now()) return false;
    e.nextProbe = this.now() + this.probeEveryMs;
    return true;
  }

  report(): HealthReport[] {
    return [...this.entries.entries()].map(([connector, e]) => ({
      connector,
      status: e.failures >= this.threshold ? "down" : "ok",
      failures: e.failures,
      ...(e.lastOk ? { last_ok: new Date(e.lastOk).toISOString() } : {}),
      ...(e.lastFailure ? { last_failure: { at: new Date(e.lastFailure.at).toISOString(), code: e.lastFailure.code } } : {}),
    }));
  }
}
