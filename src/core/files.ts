/**
 * Turns `WorkInput` (text, a local path, an https URL or base64) into bytes
 * the connector can send. Local paths are read only where the host allows it,
 * and URLs are fetched only when every address they resolve to is public.
 */
import dns from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";
import path from "node:path";
import { ProtocolError, toProtocolError } from "./errors.js";
import { WorkInputSchema, type ResolvedWork, type WorkInput } from "./types.js";
import { USER_AGENT } from "./version.js";

export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_URL_TIMEOUT_MS = 120_000;

export type Lookup = (hostname: string) => Promise<string[]>;

export type ResolveWorkOptions = {
  /** Read `file.path` from disk. Only for a process the person runs themselves. */
  allowLocalFiles: boolean;
  maxBytes?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  lookup?: Lookup;
  timeoutMs?: number;
};

export async function resolveWork(input: WorkInput, options: ResolveWorkOptions): Promise<ResolvedWork> {
  const parsed = WorkInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProtocolError("invalid_input", parsed.error.issues.map((i) => i.message).join("; "));
  }
  const work = parsed.data;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;

  if (work.text !== undefined) {
    if (!work.text.trim()) throw new ProtocolError("invalid_input", "text is empty.");
    return { kind: "text", text: work.text };
  }

  const file = work.file;
  if (!file) throw new ProtocolError("invalid_input", "Send text or a file.");

  if (file.path) {
    if (!options.allowLocalFiles) {
      throw new ProtocolError(
        "invalid_input",
        "This server does not read local paths. Send file.url (https) or file.base64, or call get_work_link to finish in a browser.",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(file.path));
    } catch (error) {
      throw new ProtocolError("not_found", `Cannot read ${file.path}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    assertSize(bytes.length, maxBytes);
    const name = file.name || path.basename(file.path);
    return finish(bytes, name, file.mime_type);
  }

  if (file.base64) {
    const body = file.base64.replace(/^data:[^;,]+;base64,/u, "").replace(/\s+/gu, "");
    const bytes = new Uint8Array(Buffer.from(body, "base64"));
    if (bytes.length === 0) throw new ProtocolError("invalid_input", "file.base64 decodes to nothing.");
    assertSize(bytes.length, maxBytes);
    if (!file.name) throw new ProtocolError("invalid_input", "file.name is needed with file.base64 (for example sample.mp3).");
    return finish(bytes, file.name, file.mime_type);
  }

  if (file.url) {
    return fetchPublicUrl(file.url, { ...options, maxBytes, name: file.name, mimeType: file.mime_type });
  }

  throw new ProtocolError("invalid_input", "Send exactly one of text, file.path, file.url or file.base64.");
}

function assertSize(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new ProtocolError(
      "invalid_input",
      `The file is ${Math.round(size / 1_048_576)} MB; the limit is ${Math.round(maxBytes / 1_048_576)} MB.`,
      {
        details: { size, max_bytes: maxBytes },
      },
    );
  }
}

function finish(bytes: Uint8Array, name: string, mimeType: string | undefined): ResolvedWork {
  const mime_type = mimeType?.split(";")[0]?.trim() || sniffMime(bytes, name) || mimeFromExtension(name) || "application/octet-stream";
  return { kind: "file", name, mime_type, bytes };
}

async function fetchPublicUrl(
  raw: string,
  options: ResolveWorkOptions & { maxBytes: number; name?: string; mimeType?: string },
): Promise<ResolvedWork> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProtocolError("invalid_input", `file.url is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:") throw new ProtocolError("invalid_input", "file.url must be https.");
  if (url.username || url.password) throw new ProtocolError("invalid_input", "file.url must not carry credentials.");
  await assertPublicHost(url.hostname, options.lookup);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_URL_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: "error", signal: controller.signal, headers: { "user-agent": USER_AGENT } });
    } catch (error) {
      const err = toProtocolError(error);
      if (err.code === "timeout") throw err;
      throw new ProtocolError(
        "upstream_error",
        `Could not fetch ${url.hostname}: ${err.message} (redirects are not followed; give the final URL).`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new ProtocolError("upstream_error", `Fetching ${url.hostname} answered ${response.status}.`, {
        details: { status: response.status },
      });
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 0) assertSize(declared, options.maxBytes);
    const bytes = await readCapped(response, options.maxBytes, controller);
    const name = options.name || decodeURIComponent(path.posix.basename(url.pathname)) || "file";
    const header = response.headers.get("content-type")?.split(";")[0]?.trim();
    const headerMime = header && header !== "application/octet-stream" ? header : undefined;
    return finish(bytes, name, options.mimeType ?? headerMime);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

async function readCapped(response: Response, maxBytes: number, controller: AbortController): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      assertSize(total, maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const defaultLookup: Lookup = async (hostname) => (await dns.lookup(hostname, { all: true })).map((r) => r.address);

/** Refuses hostnames that resolve to loopback, private, link-local or other non-public addresses. */
export async function assertPublicHost(hostname: string, lookup: Lookup = defaultLookup): Promise<void> {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ProtocolError("invalid_input", `${hostname} is not a public host.`);
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await lookup(host);
    } catch (error) {
      throw new ProtocolError("upstream_error", `Cannot resolve ${hostname}.`, { cause: error });
    }
  }
  if (addresses.length === 0) throw new ProtocolError("upstream_error", `Cannot resolve ${hostname}.`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new ProtocolError("invalid_input", `${hostname} points at a private network address; only public https URLs are fetched.`);
    }
  }
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

/** Loopback, unspecified, private, link-local, CGNAT, multicast, reserved; IPv4-mapped and NAT64 forms included. */
export function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateV4(ip);
  if (!isIPv6(ip)) return true;
  const lower = ip.toLowerCase().replace(/%.*$/u, "");
  if (lower === "::1" || lower === "::") return true;
  const mappedDotted = lower.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (mappedDotted?.[1]) return isPrivateV4(mappedDotted[1]);
  const mappedHex = lower.match(/^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (lower.startsWith("64:ff9b:")) return true;
  if (/^f[cd]/u.test(lower)) return true;
  if (/^fe[89ab]/u.test(lower)) return true;
  if (/^ff/u.test(lower)) return true;
  return false;
}

const EXTENSION_MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
};

export function mimeFromExtension(name: string): string | undefined {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext ? EXTENSION_MIME[ext] : undefined;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** The media type from the first bytes, for the formats the sources accept. */
export function sniffMime(bytes: Uint8Array, name = ""): string | undefined {
  if (bytes.length < 12) return undefined;
  const head4 = ascii(bytes, 0, 4);
  if (bytes[0] === 0x89 && head4.slice(1) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (head4 === "GIF8") return "image/gif";
  if (head4 === "RIFF") {
    const kind = ascii(bytes, 8, 4);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)/u.test(brand)) return "image/heic";
    if (brand.startsWith("qt")) return "video/quicktime";
    if (brand === "M4A ") return "audio/mp4";
    return "video/mp4";
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return path.extname(name).toLowerCase() === ".mkv" ? "video/x-matroska" : "video/webm";
  }
  if (head4.startsWith("ID3")) return "audio/mpeg";
  if (bytes[0] === 0xff && (bytes[1] === 0xfb || bytes[1] === 0xf3 || bytes[1] === 0xf2)) return "audio/mpeg";
  if (head4 === "OggS") return "audio/ogg";
  if (head4 === "fLaC") return "audio/flac";
  if (head4 === "%PDF") return "application/pdf";
  if (head4.startsWith("PK")) {
    return path.extname(name).toLowerCase() === ".docx" ? EXTENSION_MIME.docx : "application/zip";
  }
  return undefined;
}
