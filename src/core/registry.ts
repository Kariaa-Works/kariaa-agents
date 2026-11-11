import { pathToFileURL } from "node:url";
import path from "node:path";
import { defineConnector, type Connector } from "./connector.js";
import { ProtocolError } from "./errors.js";
import { defineVerifier, type Verifier } from "./verifier.js";

export class Registry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): this {
    defineConnector(connector);
    if (this.connectors.has(connector.id)) {
      throw new ProtocolError("invalid_input", `A connector with id ${JSON.stringify(connector.id)} is already registered.`);
    }
    this.connectors.set(connector.id, connector);
    return this;
  }

  registerAll(connectors: Iterable<Connector>): this {
    for (const connector of connectors) this.register(connector);
    return this;
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  has(id: string): boolean {
    return this.connectors.has(id);
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }
}

type Keys = { one: string; many: string };

/** Imports a package or a path and returns what it exports under `one`, `many` or `default`. */
async function importExports<T>(spec: string, keys: Keys, baseDir: string): Promise<T[]> {
  const isPath = spec.startsWith(".") || path.isAbsolute(spec);
  const target = isPath ? pathToFileURL(path.resolve(baseDir, spec)).href : spec;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(target)) as Record<string, unknown>;
  } catch (error) {
    throw new ProtocolError(
      "invalid_input",
      `Could not load module ${JSON.stringify(spec)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const many = mod[keys.many];
  const one = mod[keys.one];
  const fallback = mod.default;
  const found = Array.isArray(many)
    ? many
    : one
      ? [one]
      : Array.isArray(fallback)
        ? fallback
        : fallback && typeof fallback === "object"
          ? [fallback]
          : [];
  if (found.length === 0) {
    throw new ProtocolError(
      "invalid_input",
      `Module ${JSON.stringify(spec)} exports no ${keys.one} (export \`${keys.one}\`, \`${keys.many}\` or a default).`,
    );
  }
  return found as T[];
}

function split(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Loads out-of-tree connectors. A specifier is a package name, or a path
 * (relative to `baseDir`) to a module exporting `connector`, `connectors` or a default.
 * Returns the ids registered.
 */
export async function loadConnectorModules(specifiers: string[], registry: Registry, baseDir = process.cwd()): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of specifiers) {
    if (!spec.trim()) continue;
    for (const connector of await importExports<Connector>(spec.trim(), { one: "connector", many: "connectors" }, baseDir)) {
      registry.register(connector);
      ids.push(connector.id);
    }
  }
  return ids;
}

/** `WORK_CONNECTOR_MODULES=./my-connector.js,@acme/work-connector` */
export function connectorModulesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return split(env.WORK_CONNECTOR_MODULES);
}

/** Loads out-of-tree verifiers from modules exporting `verifier`, `verifiers` or a default. */
export async function loadVerifierModules(specifiers: string[], baseDir = process.cwd()): Promise<Verifier[]> {
  const verifiers: Verifier[] = [];
  for (const spec of specifiers) {
    if (!spec.trim()) continue;
    for (const verifier of await importExports<Verifier>(spec.trim(), { one: "verifier", many: "verifiers" }, baseDir)) {
      verifiers.push(defineVerifier(verifier));
    }
  }
  return verifiers;
}

/** `WORK_VERIFIER_MODULES=./my-verifier.js` */
export function verifierModulesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return split(env.WORK_VERIFIER_MODULES);
}
