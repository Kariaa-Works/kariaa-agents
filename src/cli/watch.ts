/**
 * `work watch`: a local page that follows a run as it happens and replays
 * finished ones. It reads trace files only; it never calls a platform.
 *
 * Runs come from three places: `.work/runs/` (your own runs), each
 * `workflows/<name>/trace.jsonl` (the run committed with a workflow) and the
 * sample that ships in `viz/`.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { readTrace, summarizeTrace, type TraceEvent, type TraceSummary } from "../core/trace.js";

export type RunSource = "yours" | "workflow" | "sample";
export type RunEntry = {
  id: string;
  title: string;
  source: RunSource;
  file: string;
  modified: number;
  live: boolean;
  summary: TraceSummary;
  workflow?: Record<string, unknown>;
};

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function entry(file: string, source: RunSource, id: string, title: string, workflow?: Record<string, unknown>): RunEntry | undefined {
  try {
    const stat = fs.statSync(file);
    const events = readTrace(file);
    if (events.length === 0) return undefined;
    const ended = events.some((e) => e.type === "end");
    const started = events.some((e) => e.type === "start");
    return {
      id,
      title,
      source,
      file,
      modified: stat.mtimeMs,
      // Still running: started by `work trace`, not ended, and written to in the last two minutes.
      live: started && !ended && Date.now() - stat.mtimeMs < 120_000,
      summary: summarizeTrace(events),
      ...(workflow ? { workflow } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Every run the page can show, newest of your own first, then the workflows, then the sample. */
export function listRuns(cwd: string, packageRoot: string): RunEntry[] {
  const runs: RunEntry[] = [];
  const mine = path.join(cwd, ".work", "runs");
  if (fs.existsSync(mine)) {
    const files = fs
      .readdirSync(mine)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(0, 50);
    for (const f of files) {
      const id = `yours/${f.replace(/\.jsonl$/u, "")}`;
      const e = entry(path.join(mine, f), "yours", id, f.replace(/\.jsonl$/u, "").replace(/^\d{8}-\d{6}-/u, ""));
      if (e) runs.push(e);
    }
  }
  const seen = new Set<string>();
  for (const root of [cwd, packageRoot]) {
    const dir = path.join(root, "workflows");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith("_") || seen.has(name)) continue;
      const file = path.join(dir, name, "trace.jsonl");
      if (!fs.existsSync(file)) continue;
      seen.add(name);
      const manifest = readJson(path.join(dir, name, "workflow.json"));
      const e = entry(file, "workflow", `workflow/${name}`, typeof manifest?.title === "string" ? manifest.title : name, manifest);
      if (e) runs.push(e);
    }
  }
  const sample = path.join(packageRoot, "viz", "sample-run.jsonl");
  if (fs.existsSync(sample)) {
    const e = entry(sample, "sample", "sample", "Sample run");
    if (e) runs.push(e);
  }
  return runs;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
};

export type WatchOptions = { cwd: string; packageRoot: string; port?: number; host?: string };

export function createWatchServer(options: WatchOptions): http.Server {
  const viz = path.join(options.packageRoot, "viz");
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: string | Buffer, type: string) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      if (req.method !== "GET") return send(405, "GET only", "text/plain");
      if (url.pathname === "/api/runs") {
        const runs = listRuns(options.cwd, options.packageRoot).map(({ file: _file, ...rest }) => rest);
        return send(200, JSON.stringify({ runs }), "application/json");
      }
      if (url.pathname === "/api/run") {
        const id = url.searchParams.get("id") ?? "";
        const run = listRuns(options.cwd, options.packageRoot).find((r) => r.id === id);
        if (!run) return send(404, JSON.stringify({ error: "not_found" }), "application/json");
        const events: TraceEvent[] = readTrace(run.file);
        const { file: _file, ...rest } = run;
        return send(200, JSON.stringify({ ...rest, events }), "application/json");
      }
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(viz, relative);
      if (!file.startsWith(viz + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile())
        return send(404, "Not found", "text/plain");
      return send(200, fs.readFileSync(file), TYPES[path.extname(file)] ?? "application/octet-stream");
    } catch (error) {
      return send(500, error instanceof Error ? error.message : String(error), "text/plain");
    }
  });
}

/** Writes the page and every run into one folder that any static host can serve (GitHub Pages). */
export function exportWatch(options: { cwd: string; packageRoot: string; out: string }): { out: string; runs: number } {
  const viz = path.join(options.packageRoot, "viz");
  fs.mkdirSync(options.out, { recursive: true });
  for (const name of fs.readdirSync(viz)) {
    const from = path.join(viz, name);
    if (fs.statSync(from).isFile() && !name.endsWith(".jsonl")) fs.copyFileSync(from, path.join(options.out, name));
  }
  const runs = listRuns(options.cwd, options.packageRoot)
    .filter((r) => r.source !== "yours")
    .map(({ file, ...rest }) => ({ ...rest, live: false, events: readTrace(file) }));
  fs.writeFileSync(path.join(options.out, "runs.json"), JSON.stringify({ runs }), "utf8");
  return { out: options.out, runs: runs.length };
}

export async function listenWatch(options: WatchOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createWatchServer(options);
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8791, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : (options.port ?? 8791);
  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
