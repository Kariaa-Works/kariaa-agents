/**
 * `work login <id>`: run the OAuth authorization-code flow against a linked
 * MCP server with a local callback, then prove the sign-in with tools/list.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { UnauthorizedError, auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProtocolError } from "./errors.js";
import { FileOAuthProvider } from "./oauth.js";
import { VERSION } from "./version.js";

export type LoginOptions = {
  id: string;
  url: string;
  scope?: string;
  /** Local callback port. Default 8790. */
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the person. Default 5 minutes. */
  timeoutMs?: number;
  /** Shown the URL to open; default prints it and tries the system browser. */
  onAuthorize?: (url: URL) => void | Promise<void>;
  log?: (text: string) => void;
};

/** Opens a URL in the system browser without waiting; errors are ignored. */
export function openInBrowser(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url.replace(/&/gu, "^&")], { detached: true, stdio: "ignore" })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser available
  }
}

/** Waits for the authorization code on a local callback server. */
function waitForCode(
  port: number,
  expectedState: () => string | undefined,
  timeoutMs: number,
): { ready: Promise<void>; code: Promise<string>; close: () => void } {
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("not found");
      return;
    }
    const error = url.searchParams.get("error");
    const received = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expected = expectedState();
    if (error) {
      res.writeHead(400, { "content-type": "text/plain" }).end(`Sign-in failed: ${error}`);
      rejectCode(
        new ProtocolError(
          "auth_required",
          `The authorization server answered ${error}: ${url.searchParams.get("error_description") ?? ""}`.trim(),
        ),
      );
      return;
    }
    if (!received || (expected && state !== expected)) {
      res.writeHead(400, { "content-type": "text/plain" }).end("Missing code or state mismatch.");
      rejectCode(new ProtocolError("auth_required", "The callback carried no code, or the state did not match."));
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>Signed in</title><p>Signed in. You can close this tab.</p>");
    resolveCode(received);
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const timer = setTimeout(
    () => rejectCode(new ProtocolError("timeout", `No sign-in within ${Math.round(timeoutMs / 1000)} s.`)),
    timeoutMs,
  );
  return {
    ready,
    code,
    close: () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    },
  };
}

/** Runs the sign-in and returns how many tools the server offers once signed in. */
export async function loginMcp(options: LoginOptions): Promise<{ tools: number; file: string }> {
  const port = options.port ?? 8790;
  const log = options.log ?? ((text: string) => process.stderr.write(`${text}\n`));
  const provider = new FileOAuthProvider(options.id, {
    env: options.env,
    redirectPort: port,
    scope: options.scope,
    onAuthorize:
      options.onAuthorize ??
      ((url) => {
        log(`Open this URL to sign in to ${options.id}:\n${url.href}`);
        openInBrowser(url.href);
      }),
  });
  const callback = waitForCode(port, () => provider.expectedState, options.timeoutMs ?? 300_000);
  await callback.ready;
  try {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), { authProvider: provider });
    const client = new Client({ name: "work-protocol", version: VERSION });
    let needsCode = false;
    try {
      await client.connect(transport);
    } catch (error) {
      if (!(error instanceof UnauthorizedError) && (error as { name?: string })?.name !== "UnauthorizedError") throw error;
      needsCode = true;
    }
    const signedIn = async () => {
      const again = new StreamableHTTPClientTransport(new URL(options.url), { authProvider: provider });
      const fresh = new Client({ name: "work-protocol", version: VERSION });
      await fresh.connect(again);
      const { tools } = await fresh.listTools();
      await fresh.close();
      return { tools: tools.length, file: provider.file };
    };
    if (needsCode) {
      const code = await callback.code;
      await transport.finishAuth(code);
      return await signedIn();
    }
    if (!provider.tokens()) {
      // The server lets anonymous clients in, but its account tools need a token: sign in anyway.
      await client.close();
      const started = await auth(provider, { serverUrl: options.url, ...(options.scope ? { scope: options.scope } : {}) });
      if (started === "REDIRECT") await auth(provider, { serverUrl: options.url, authorizationCode: await callback.code });
      return await signedIn();
    }
    const { tools } = await client.listTools();
    await client.close();
    return { tools: tools.length, file: provider.file };
  } finally {
    callback.close();
  }
}
