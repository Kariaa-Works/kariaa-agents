/**
 * Reads what a file says about itself from its bytes: media type, kind,
 * duration (WAV, MP4, MOV, M4A) and image size (PNG, JPEG). Pure, no
 * decoding, so verifiers stay deterministic and fast.
 */
import { mimeFromExtension, sniffMime } from "./files.js";

export type MediaKindOf = "image" | "audio" | "video" | "text" | "other";

export type MediaInfo = {
  mime?: string;
  kind: MediaKindOf;
  /** Seconds, when the container states it. */
  duration_seconds?: number;
  width?: number;
  height?: number;
  /** false when the format is known but the bytes could not be read as it, or it is not parsed here. */
  readable: boolean;
};

export function kindOfMime(mime: string | undefined): MediaKindOf {
  if (!mime) return "other";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (
    mime.startsWith("text/") ||
    mime === "application/pdf" ||
    mime === "application/json" ||
    mime === "application/msword" ||
    mime.includes("wordprocessingml")
  )
    return "text";
  return "other";
}

const u32be = (b: Uint8Array, i: number): number => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const u32le = (b: Uint8Array, i: number): number => b[i]! + (b[i + 1]! << 8) + (b[i + 2]! << 16) + ((b[i + 3]! << 24) >>> 0);
const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) + b[i + 1]!;
const tag = (b: Uint8Array, i: number): string => String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);

/** Duration of a RIFF WAVE file from its fmt and data chunks. */
export function wavDuration(bytes: Uint8Array): number | undefined {
  if (bytes.length < 44 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") return undefined;
  let i = 12;
  let byteRate: number | undefined;
  let dataSize: number | undefined;
  while (i + 8 <= bytes.length) {
    const id = tag(bytes, i);
    const size = u32le(bytes, i + 4);
    if (id === "fmt " && i + 20 <= bytes.length) byteRate = u32le(bytes, i + 16);
    if (id === "data") {
      dataSize = Math.min(size, bytes.length - i - 8);
      break;
    }
    i += 8 + size + (size % 2);
  }
  if (!byteRate || dataSize === undefined) return undefined;
  return dataSize / byteRate;
}

function findBox(bytes: Uint8Array, from: number, to: number, type: string): { start: number; end: number } | undefined {
  let i = from;
  while (i + 8 <= to) {
    let size = u32be(bytes, i);
    const t = tag(bytes, i + 4);
    let header = 8;
    if (size === 1) {
      if (i + 16 > to) return undefined;
      size = u32be(bytes, i + 8) * 4294967296 + u32be(bytes, i + 12);
      header = 16;
    } else if (size === 0) {
      size = to - i;
    }
    if (size < header) return undefined;
    if (t === type) return { start: i, end: Math.min(to, i + size) };
    i += size;
  }
  return undefined;
}

/** Duration of an ISO base media file (MP4, M4A, MOV) from moov/mvhd. */
export function mp4Duration(bytes: Uint8Array): number | undefined {
  if (bytes.length < 16 || tag(bytes, 4) !== "ftyp") return undefined;
  const moov = findBox(bytes, 0, bytes.length, "moov");
  if (!moov) return undefined;
  const mvhd = findBox(bytes, moov.start + 8, moov.end, "mvhd");
  if (!mvhd) return undefined;
  const p = mvhd.start + 8;
  const version = bytes[p];
  if (version === 0 && p + 20 <= mvhd.end) {
    const timescale = u32be(bytes, p + 12);
    return timescale ? u32be(bytes, p + 16) / timescale : undefined;
  }
  if (version === 1 && p + 32 <= mvhd.end) {
    const timescale = u32be(bytes, p + 20);
    const duration = u32be(bytes, p + 24) * 4294967296 + u32be(bytes, p + 28);
    return timescale ? duration / timescale : undefined;
  }
  return undefined;
}

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || tag(bytes, 12) !== "IHDR") return undefined;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > bytes.length) return undefined;
      return { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(bytes, i + 2);
    if (length < 2) return undefined;
    i += 2 + length;
  }
  return undefined;
}

/** What the bytes say about a file. Never throws. */
export function inspectMedia(bytes: Uint8Array, name?: string, declaredMime?: string): MediaInfo {
  const mime = sniffMime(bytes, name) ?? (name ? mimeFromExtension(name) : undefined) ?? declaredMime?.split(";")[0]?.trim();
  const kind = kindOfMime(mime);
  const info: MediaInfo = { kind, readable: true, ...(mime ? { mime } : {}) };
  try {
    if (mime === "audio/wav") {
      const d = wavDuration(bytes);
      if (d === undefined) info.readable = false;
      else info.duration_seconds = d;
    } else if (mime === "video/mp4" || mime === "video/quicktime" || mime === "audio/mp4") {
      const d = mp4Duration(bytes);
      if (d === undefined) info.readable = false;
      else info.duration_seconds = d;
    } else if (mime === "image/png") {
      const dims = pngDimensions(bytes);
      if (dims) Object.assign(info, dims);
      else info.readable = false;
    } else if (mime === "image/jpeg") {
      const dims = jpegDimensions(bytes);
      if (dims) Object.assign(info, dims);
      else info.readable = false;
    } else if (kind === "audio" || kind === "video" || kind === "image") {
      info.readable = false;
    }
  } catch {
    info.readable = false;
  }
  return info;
}
