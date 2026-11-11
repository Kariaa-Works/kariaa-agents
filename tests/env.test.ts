import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDotEnv } from "../src/core/env.js";
import { redact } from "../src/core/trace.js";
import { main } from "../src/cli/index.js";

describe("parseDotEnv", () => {
  it("reads KEY=value lines, quotes, export and comments", () => {
    expect(
      parseDotEnv(
        [
          "# a comment",
          "KARIAA_API_KEY=kra_abc",
          'QUOTED="two words"',
          "SINGLE='x y'",
          "export EXPORTED=1",
          "TRAILING=value # note",
          "",
          "not a line",
          "EMPTY=",
        ].join("\r\n"),
      ),
    ).toEqual({ KARIAA_API_KEY: "kra_abc", QUOTED: "two words", SINGLE: "x y", EXPORTED: "1", TRAILING: "value", EMPTY: "" });
  });
});

describe("what a trace keeps out", () => {
  it("masks phone numbers, sign-in links, home folders and personal fields wherever they appear", () => {
    const out = JSON.stringify(
      redact({
        note: "Call me on +1 (415) 555-0134 or 020 7946 0958. Order 12345 stays.",
        url: "https://www.kariaa.com/auth/magic?token_hash=abcdef123456&next=/tasks",
        other: "https://files.example/x#access_token=zzzzzzzzzzzz",
        path: "C:\\Users\\sam\\clips\\one.mp4",
        unix: "/home/sam/clips/one.mp4",
        phone_number: "4155550134",
        legal_first_name: "Sam",
        location: "Accra, Ghana",
      }),
    );
    for (const secret of [
      "555-0134",
      "7946",
      "abcdef123456",
      "zzzzzzzzzzzz",
      "\\\\sam\\\\",
      "/home/sam/",
      "4155550134",
      '"Sam"',
      "Accra",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("Order 12345 stays");
    expect(out).toContain("https://www.kariaa.com/auth/magic");
  });
});

describe("work, the command", () => {
  const io = () => {
    const box = { out: "", err: "" };
    return {
      box,
      io: {
        stdout: (t: string) => (box.out += t),
        stderr: (t: string) => (box.err += t),
        env: { WORK_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "work-cli-")) },
      },
    };
  };

  it("prints its version", async () => {
    const a = io();
    expect(await main(["--version"], a.io)).toBe(0);
    expect(a.box.out.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("shows one command's help", async () => {
    const a = io();
    expect(await main(["help", "search"], a.io)).toBe(0);
    expect(a.box.out).toContain("work search");
    expect(a.box.out).not.toContain("work payout");
  });

  it("refuses a kind or category it does not know", async () => {
    const a = io();
    expect(await main(["search", "x", "--kind", "bogus"], a.io)).toBe(1);
    expect(a.box.err).toContain("--kind is task or listing");
    const b = io();
    expect(await main(["search", "x", "--category", "nope"], b.io)).toBe(1);
    expect(b.box.err).toContain("--category is one of");
  });
});
