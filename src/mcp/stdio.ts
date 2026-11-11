/**
 * The MCP server over stdio, for Claude Desktop, Claude Code, Cursor and other
 * local hosts. Everything logged goes to stderr; stdout is the protocol channel.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProtocol } from "../index.js";
import { fileCredentialStore } from "../core/connect.js";
import { isEntryPoint, loadDotEnv } from "../core/env.js";
import { JobCache, defaultCacheFile } from "../core/jobCache.js";
import { localIndexIfBuilt } from "../search/index.js";
import { createWorkMcpServer } from "./server.js";

export async function runStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env === process.env) loadDotEnv();
  const log = (event: string, data?: Record<string, unknown>) => {
    if (env.WORK_LOG === "1") process.stderr.write(`${JSON.stringify({ event, ...data })}\n`);
  };
  const index = env.WORK_INDEX === "off" ? undefined : localIndexIfBuilt(env);
  const protocol = await createProtocol({
    ...(index ? { index } : {}),
    env,
    allowLocalFiles: true,
    cache: new JobCache({ file: defaultCacheFile(env) }),
    credentialStore: fileCredentialStore(env),
    log,
  });
  const server = createWorkMcpServer(protocol, { allowLocalFiles: true });
  const transport = new StdioServerTransport();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await protocol.close();
    // Let the process end on its own: exiting while a request's handle is still closing aborts Node on Windows.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.stdin.once("end", () => void shutdown());
  process.stdin.once("close", () => void shutdown());
  await server.connect(transport);
}

if (isEntryPoint(import.meta.url)) {
  runStdio().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}
