import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `KEY=value` lines of a .env file. Quotes are stripped, `export ` is allowed, `#` starts a comment. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/gu, "\n");
    } else {
      // An unquoted value ends at a ` #` comment.
      value = value.replace(/\s+#.*$/u, "");
    }
    out[match[1]!] = value;
  }
  return out;
}

/**
 * Loads `.env` from the repo root and from the working directory into
 * `process.env`, without overriding variables already set. Works on every
 * supported Node version. Returns the files it read.
 */
export function loadDotEnv(extraDirs: string[] = []): string[] {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const loaded: string[] = [];
  for (const dir of [repoRoot, process.cwd(), ...extraDirs]) {
    const file = path.join(dir, ".env");
    if (!existsSync(file) || loaded.includes(file)) continue;
    try {
      for (const [name, value] of Object.entries(parseDotEnv(readFileSync(file, "utf8")))) {
        if (process.env[name] === undefined || process.env[name] === "") process.env[name] = value;
      }
      loaded.push(file);
    } catch {
      // unreadable: ignore
    }
  }
  return loaded;
}

/**
 * Whether the module at `metaUrl` is the script Node was started with. Compares
 * real paths, so it holds when the command runs through a symlink or junction
 * (`npm link`, a global install, `npx`).
 */
export function isEntryPoint(metaUrl: string): boolean {
  const started = process.argv[1];
  if (!started) return false;
  try {
    return realpathSync(started) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
