/** Synthetic media files with real headers, so verifiers can be tested without binary fixtures. */
import type { NativeJob, ResolvedWork } from "../../src/core/types.js";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];

function filler(length: number, seed: number): number[] {
  const out = new Array<number>(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 17 + ((i * seed) % 13)) & 255;
  return out;
}

/** 8-bit mono PCM WAV of `seconds` at 2000 samples per second. */
export function wav(seconds: number, seed = 1, sampleRate = 2000): Uint8Array {
  const dataSize = Math.round(seconds * sampleRate);
  const bytes = [
    ...ascii("RIFF"),
    ...u32le(36 + dataSize),
    ...ascii("WAVE"),
    ...ascii("fmt "),
    ...u32le(16),
    ...u16le(1),
    ...u16le(1),
    ...u32le(sampleRate),
    ...u32le(sampleRate),
    ...u16le(1),
    ...u16le(8),
    ...ascii("data"),
    ...u32le(dataSize),
    ...filler(dataSize, seed),
  ];
  return new Uint8Array(bytes);
}

function box(type: string, body: number[]): number[] {
  return [...u32be(8 + body.length), ...ascii(type), ...body];
}

/** An ISO base media file whose mvhd states `seconds`, with `mdatBytes` of payload. */
export function mp4(seconds: number, seed = 1, mdatBytes = 9000, brand = "isom"): Uint8Array {
  const ftyp = box("ftyp", [...ascii(brand), ...u32be(0), ...ascii(brand)]);
  const mvhd = box("mvhd", [
    0,
    0,
    0,
    0, // version + flags
    ...u32be(0), // creation
    ...u32be(0), // modification
    ...u32be(1000), // timescale
    ...u32be(Math.round(seconds * 1000)), // duration
    ...u32be(0x00010000), // rate
    ...u16be(0x0100), // volume
    ...new Array<number>(10).fill(0), // reserved
    ...new Array<number>(36).fill(0), // matrix
    ...new Array<number>(24).fill(0), // pre-defined
    ...u32be(2), // next track id
  ]);
  const moov = box("moov", mvhd);
  const mdat = box("mdat", filler(mdatBytes, seed));
  return new Uint8Array([...ftyp, ...moov, ...mdat]);
}

/** A PNG with an IHDR of `width` × `height` and enough payload to be a real file. */
export function png(width: number, height: number, seed = 1, payload = 1500): Uint8Array {
  const ihdr = [...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height), 8, 2, 0, 0, 0, 0, 0, 0, 0];
  const idat = [...u32be(payload), ...ascii("IDAT"), ...filler(payload, seed), 0, 0, 0, 0];
  const iend = [...u32be(0), ...ascii("IEND"), 0xae, 0x42, 0x60, 0x82];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...idat, ...iend]);
}

/** A JPEG with a SOF0 of `width` × `height`. */
export function jpeg(width: number, height: number, seed = 1, payload = 1500): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const app1 = [0xff, 0xe1, ...u16be(2 + payload), ...filler(payload, seed).map((b) => (b === 0xff ? 0xfe : b))];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, ...app1, 0xff, 0xd9]);
}

/** MP3-looking bytes: an ID3 tag and no readable duration. */
export function mp3ish(seed = 1, length = 3000): Uint8Array {
  return new Uint8Array([...ascii("ID3"), 4, 0, 0, 0, 0, 0, 0, ...filler(length, seed)]);
}

export function file(name: string, mime_type: string, bytes: Uint8Array): ResolvedWork {
  return { kind: "file", name, mime_type, bytes };
}

export function textWork(text: string): ResolvedWork {
  return { kind: "text", text };
}

export const AUDIO_TASK: NativeJob = {
  id: "t-audio",
  kind: "task",
  title: "Read sentences aloud",
  instructions: "1. The cat sat on the mat. 2. Rain is expected tomorrow.",
  pay: { min: 0.5, max: 0.5, currency: "USD", period: "unit", unit: "per clip" },
  requirements: {
    questions: [{ id: "language", question: "Which language?", type: "select", options: ["English", "Twi", "French"], required: true }],
    files: { kinds: ["audio"], count: 2, max_seconds: 30, max_bytes: 100 * 1024 * 1024 },
  },
};

export const VIDEO_TASK: NativeJob = {
  id: "t-video",
  kind: "task",
  title: "Everyday tasks on video",
  pay: { min: 1, max: 1, currency: "USD", period: "unit", unit: "per clip" },
  requirements: { files: { kinds: ["video"], count: 2, max_seconds: 60 } },
};

export const IMAGE_TASK: NativeJob = {
  id: "t-image",
  kind: "task",
  title: "Object capture",
  pay: { min: 0.3, max: 0.3, currency: "USD", period: "unit", unit: "per photo" },
  requirements: { files: { kinds: ["image"], count: 3 } },
};

export const TEXT_TASK: NativeJob = {
  id: "t-text",
  kind: "task",
  title: "Label short texts",
  instructions: "Text A: 'Great service, will come back.' Labels: positive, negative, neutral.",
  pay: { min: 2, max: 2, currency: "USD", period: "unit", unit: "per task" },
  requirements: { files: { kinds: ["text"], count: 1 }, text: { min_chars: 20, max_chars: 20_000 } },
};
