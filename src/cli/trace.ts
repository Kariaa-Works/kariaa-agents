/**
 * `work trace -- <command>`: runs a workflow and records every protocol call
 * it makes. The child gets WORK_TRACE_FILE; anything built on `createProtocol`
 * (the library, the `work` CLI, `work mcp`) writes to it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appendTrace, readTrace, redact, summarizeTrace, type TraceSummary } from "../core/trace.js";

export type TraceRunOptions = {
  command: string[];
  name?: string;
  /** Where the trace goes. Default: `.work/runs/<run>.jsonl` under the working folder. */
  out?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "ignore";
};

export type TraceRunResult = { file: string; run: string; exit: number; summary: TraceSummary };

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || "run"
  );
}

/** One argument, quoted for the platform shell when it needs it. */
function quote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/u.test(arg)) return arg;
  return process.platform === "win32" ? `"${arg.replace(/"/gu, '\\"')}"` : `'${arg.replace(/'/gu, `'\\''`)}'`;
}

export async function runTraced(options: TraceRunOptions): Promise<TraceRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const started = new Date();
  // `npx tsx workflows/scout/run.ts` is the run "scout": the folder the script is in.
  const script = options.command.find((part) => /[\\/]/u.test(part));
  const name = options.name ?? slug(script ? path.basename(path.dirname(script)) : (options.command[0] ?? "run"));
  const run = `${stamp(started)}-${slug(name)}`;
  const file = path.resolve(cwd, options.out ?? path.join(".work", "runs", `${run}.jsonl`));
  if (options.out && fs.existsSync(file)) fs.rmSync(file);
  appendTrace(file, { type: "start", v: 1, ts: started.toISOString(), run, name, command: String(redact(options.command.join(" "))) });

  const exit = await new Promise<number>((resolve) => {
    const child = spawn(options.command.map(quote).join(" "), {
      cwd,
      shell: true,
      stdio: options.stdio ?? "inherit",
      env: { ...(options.env ?? process.env), WORK_TRACE_FILE: file, WORK_TRACE_RUN: run },
    });
    child.once("error", () => resolve(127));
    child.once("exit", (code) => resolve(code ?? 1));
  });

  appendTrace(file, { type: "end", ts: new Date().toISOString(), exit, ms: Date.now() - started.getTime() });
  return { file, run, exit, summary: summarizeTrace(readTrace(file)) };
}

export function renderSummary(summary: TraceSummary): string {
  const seconds = (summary.ms / 1000).toFixed(1);
  const v = summary.verified;
  return [
    `Run ${summary.run ?? ""}${summary.exit === undefined ? "" : summary.exit === 0 ? " finished" : ` exited ${summary.exit}`} in ${seconds}s`,
    `  calls      ${summary.calls} (${summary.failed} failed)`,
    `  found      ${summary.found} from ${summary.connectors.length} source${summary.connectors.length === 1 ? "" : "s"}${summary.connectors.length ? `: ${summary.connectors.join(", ")}` : ""}`,
    `  applied    ${summary.applied}`,
    `  verified   ${v.pass} pass, ${v.fail} fail, ${v.uncertain} uncertain`,
    `  submitted  ${summary.submitted}`,
    `  accepted   ${summary.accepted}`,
  ].join("\n");
}
