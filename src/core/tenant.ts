/**
 * Who a connector call is for, when one process serves many people (the hosted server).
 * Connectors that keep drafts or pending uploads on disk go through `stateDir` and `perTenant`,
 * so one person's staged work never shows up in another's `list` or `status`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const scope = new AsyncLocalStorage<string>();

/** Runs `fn` on behalf of `tenant`. Without a tenant it runs as the local, single user. */
export function runAsTenant<T>(tenant: string | undefined, fn: () => T): T {
  return tenant ? scope.run(tenant, fn) : fn();
}

export function currentTenant(): string | undefined {
  return scope.getStore();
}

function tenantKey(tenant: string): string {
  return createHash("sha256").update(tenant).digest("hex").slice(0, 32);
}

/** The cache folder: `WORK_CACHE_DIR` or `~/.cache/work-protocol`, plus `tenants/<hash>` inside a tenant. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.WORK_CACHE_DIR?.trim() || path.join(os.homedir(), ".cache", "work-protocol");
  const tenant = currentTenant();
  return tenant ? path.join(base, "tenants", tenantKey(tenant)) : base;
}

/**
 * One instance per tenant, made on first use. For stores that hold a file's contents in memory.
 * The local single user gets one shared instance, as before.
 */
export function perTenant<T>(make: () => T): () => T {
  const local: { value?: T } = {};
  const byTenant = new Map<string, T>();
  return () => {
    const tenant = currentTenant();
    if (!tenant) return (local.value ??= make());
    let value = byTenant.get(tenant);
    if (value === undefined) {
      value = make();
      byTenant.set(tenant, value);
    }
    return value;
  };
}
