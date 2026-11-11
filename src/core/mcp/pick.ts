/**
 * The tiny path language profiles use to read tool results:
 *   $            the whole value
 *   $.a.b        properties
 *   $.a[0]       an index
 *   $.a[*].b     every element, then a property of each
 */
const PATH = /^\$(\.[^.[\]]+|\[(\d+|\*)\])*$/u;
const SEGMENT = /\.([^.[\]]+)|\[(\d+|\*)\]/gu;

export function isPath(value: unknown): value is string {
  return typeof value === "string" && PATH.test(value);
}

function step(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return /^\d+$/u.test(key) ? value[Number(key)] : undefined;
  return (value as Record<string, unknown>)[key];
}

/** The value at `path`, or undefined. After `[*]` the result is an array of what each element gave. */
export function pick(value: unknown, path: string): unknown {
  if (!isPath(path)) throw new Error(`Not a path: ${path}`);
  if (path === "$") return value;
  let current: unknown = value;
  let fanned = false;
  for (const match of path.slice(1).matchAll(SEGMENT)) {
    const key = match[1] ?? match[2] ?? "";
    if (key === "*") {
      if (fanned) current = (current as unknown[]).flatMap((v) => (Array.isArray(v) ? v : []));
      else current = Array.isArray(current) ? current : [];
      fanned = true;
      continue;
    }
    if (fanned) current = (current as unknown[]).map((v) => step(v, key)).filter((v) => v !== undefined);
    else current = step(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}

/** `${slug}` or `${$.company.slug}` inside a string, from `scope`. Unknown values become empty. */
export function template(text: string, scope: unknown): string {
  return text.replace(/\$\{([^}]+)\}/gu, (_m, inner: string) => {
    const path = inner.trim().startsWith("$") ? inner.trim() : `$.${inner.trim()}`;
    const value = isPath(path) ? pick(scope, path) : undefined;
    return value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** Sets `a.b.c` on an object, creating the levels. */
export function setDeep(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let current = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]!;
    const next = current[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}
