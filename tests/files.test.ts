import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureFetch } from "../src/core/conformance.js";
import { assertPublicHost, isPrivateAddress, mimeFromExtension, resolveWork, sniffMime } from "../src/core/files.js";

const publicLookup = async () => ["93.184.216.34"];
const privateLookup = async () => ["93.184.216.34", "10.0.0.8"];

describe("resolveWork", () => {
  it("takes text", async () => {
    expect(await resolveWork({ text: "hello world" }, { allowLocalFiles: false })).toEqual({ kind: "text", text: "hello world" });
    await expect(resolveWork({ text: "   " }, { allowLocalFiles: false })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("insists on exactly one source", async () => {
    await expect(resolveWork({}, { allowLocalFiles: true })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolveWork({ text: "a", file: { url: "https://x" } }, { allowLocalFiles: true })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(resolveWork({ file: { url: "https://x", base64: "aa" } }, { allowLocalFiles: true })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("reads a local path only when allowed, and sniffs the type", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "work-protocol-"));
    const file = path.join(dir, "shot.bin");
    writeFileSync(file, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(32)]));
    await expect(resolveWork({ file: { path: file } }, { allowLocalFiles: false })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("local paths"),
    });
    const work = await resolveWork({ file: { path: file } }, { allowLocalFiles: true });
    expect(work).toMatchObject({ kind: "file", name: "shot.bin", mime_type: "image/png" });
    await expect(resolveWork({ file: { path: path.join(dir, "missing.png") } }, { allowLocalFiles: true })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(resolveWork({ file: { path: file } }, { allowLocalFiles: true, maxBytes: 10 })).rejects.toMatchObject({
      code: "invalid_input",
      details: { max_bytes: 10 },
    });
  });

  it("decodes base64 and needs a name", async () => {
    const b64 = Buffer.from("ID3 fake audio bytes here").toString("base64");
    await expect(resolveWork({ file: { base64: b64 } }, { allowLocalFiles: false })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("file.name"),
    });
    const work = await resolveWork({ file: { base64: `data:audio/mpeg;base64,${b64}`, name: "clip.mp3" } }, { allowLocalFiles: false });
    expect(work).toMatchObject({ kind: "file", name: "clip.mp3", mime_type: "audio/mpeg" });
    expect(work.kind === "file" && work.bytes.byteLength).toBe(25);
    await expect(resolveWork({ file: { base64: "!!!", name: "x.bin" } }, { allowLocalFiles: false })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("fetches only public https URLs, without following redirects, and honours the type header", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = fixtureFetch((url, init) => {
      seen.push(init ?? {});
      if (url.endsWith("/404")) return new Response("no", { status: 404 });
      if (url.endsWith("/big")) return new Response("x", { status: 200, headers: { "content-length": "999999999" } });
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3]), {
        status: 200,
        headers: { "content-type": "application/pdf; charset=binary" },
      });
    });
    await expect(
      resolveWork({ file: { url: "http://example.com/a.pdf" } }, { allowLocalFiles: false, fetch: fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("https") });
    await expect(
      resolveWork({ file: { url: "https://localhost/a.pdf" } }, { allowLocalFiles: false, fetch: fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      resolveWork({ file: { url: "https://internal.example/a.pdf" } }, { allowLocalFiles: false, fetch: fetchImpl, lookup: privateLookup }),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("private") });
    await expect(
      resolveWork(
        { file: { url: "https://user:pw@example.com/a.pdf" } },
        { allowLocalFiles: false, fetch: fetchImpl, lookup: publicLookup },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const work = await resolveWork(
      { file: { url: "https://example.com/files/report%20final.pdf" } },
      { allowLocalFiles: false, fetch: fetchImpl, lookup: publicLookup },
    );
    expect(work).toMatchObject({ kind: "file", name: "report final.pdf", mime_type: "application/pdf" });
    expect(seen[0]?.redirect).toBe("error");
    await expect(
      resolveWork({ file: { url: "https://example.com/404" } }, { allowLocalFiles: false, fetch: fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "upstream_error", details: { status: 404 } });
    await expect(
      resolveWork(
        { file: { url: "https://example.com/big" } },
        { allowLocalFiles: false, fetch: fetchImpl, lookup: publicLookup, maxBytes: 1000 },
      ),
    ).rejects.toMatchObject({ code: "invalid_input", details: { max_bytes: 1000 } });
  });
});

describe("private address detection", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["224.0.0.1", true],
    ["::1", true],
    ["::", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::ffff:808:808", false],
    ["fd00::1", true],
    ["fe80::1", true],
    ["64:ff9b::808:808", true],
    ["2606:4700::1111", false],
    ["not-an-ip", true],
  ])("%s private=%s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it("checks every resolved address", async () => {
    await expect(assertPublicHost("example.com", privateLookup)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(assertPublicHost("example.com", publicLookup)).resolves.toBeUndefined();
    await expect(assertPublicHost("10.0.0.1", publicLookup)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(assertPublicHost("metadata.internal", publicLookup)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      assertPublicHost("nx.example", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toMatchObject({ code: "upstream_error" });
  });
});

describe("mime detection", () => {
  const bytes = (hex: string, pad = 16) => new Uint8Array(Buffer.concat([Buffer.from(hex, "hex"), Buffer.alloc(pad)]));
  it("sniffs the formats the sources accept", () => {
    expect(sniffMime(bytes("89504e470d0a1a0a"))).toBe("image/png");
    expect(sniffMime(bytes("ffd8ffe0"))).toBe("image/jpeg");
    expect(sniffMime(new Uint8Array(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")))).toBe("image/webp");
    expect(sniffMime(new Uint8Array(Buffer.from("RIFF\0\0\0\0WAVEfmt ")))).toBe("audio/wav");
    expect(sniffMime(new Uint8Array(Buffer.from("\0\0\0\x18ftypisom\0\0\0\0")))).toBe("video/mp4");
    expect(sniffMime(new Uint8Array(Buffer.from("\0\0\0\x18ftypqt  \0\0\0\0")))).toBe("video/quicktime");
    expect(sniffMime(new Uint8Array(Buffer.from("\0\0\0\x18ftypM4A \0\0\0\0")))).toBe("audio/mp4");
    expect(sniffMime(new Uint8Array(Buffer.from("\0\0\0\x18ftypheic\0\0\0\0")))).toBe("image/heic");
    expect(sniffMime(bytes("1a45dfa3"))).toBe("video/webm");
    expect(sniffMime(bytes("1a45dfa3"), "film.mkv")).toBe("video/x-matroska");
    expect(sniffMime(new Uint8Array(Buffer.from("ID3\x04\0\0\0\0\0\0\0\0\0\0\0\0")))).toBe("audio/mpeg");
    expect(sniffMime(bytes("fffb9064"))).toBe("audio/mpeg");
    expect(sniffMime(new Uint8Array(Buffer.from("OggS\0\0\0\0\0\0\0\0\0\0\0\0")))).toBe("audio/ogg");
    expect(sniffMime(new Uint8Array(Buffer.from("%PDF-1.4\n%\0\0\0\0\0\0")))).toBe("application/pdf");
    expect(sniffMime(bytes("504b0304"), "cv.docx")).toContain("wordprocessingml");
    expect(sniffMime(bytes("504b0304"), "cv.zip")).toBe("application/zip");
    expect(sniffMime(new Uint8Array(Buffer.from("just some plain text here")))).toBeUndefined();
    expect(sniffMime(new Uint8Array(3))).toBeUndefined();
  });
  it("falls back to the extension", () => {
    expect(mimeFromExtension("notes.TXT")).toBe("text/plain");
    expect(mimeFromExtension("clip.m4a")).toBe("audio/mp4");
    expect(mimeFromExtension("noext")).toBeUndefined();
  });
});
