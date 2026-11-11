import { describe, expect, it } from "vitest";
import { inspectMedia, jpegDimensions, mp4Duration, pngDimensions, wavDuration } from "../src/core/media.js";
import { combineOutcomes, defineVerifier, payFor, verifierApplies, verifyWork, type Verifier } from "../src/core/verifier.js";
import { builtInVerifiers } from "../src/verifiers/index.js";
import { fingerprint } from "../src/verifiers/duplicates/index.js";
import { AUDIO_TASK, IMAGE_TASK, TEXT_TASK, VIDEO_TASK, file, jpeg, mp3ish, mp4, png, textWork, wav } from "./helpers/media.js";

const run = (
  input: Parameters<typeof verifyWork>[0],
  verifiers: Verifier[] = builtInVerifiers,
  ctx?: Parameters<typeof verifyWork>[1]["ctx"],
) => verifyWork(input, { verifiers, ...(ctx ? { ctx } : {}) });

describe("media parsing", () => {
  it("reads durations and dimensions from headers", () => {
    expect(wavDuration(wav(10))).toBeCloseTo(10, 3);
    expect(mp4Duration(mp4(42.5))).toBeCloseTo(42.5, 3);
    expect(pngDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(jpegDimensions(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(wavDuration(new Uint8Array(10))).toBeUndefined();
    expect(mp4Duration(new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]))).toBeUndefined();
  });

  it("describes files, and marks unparsed formats unreadable", () => {
    expect(inspectMedia(wav(3), "clip.wav")).toMatchObject({ mime: "audio/wav", kind: "audio", readable: true, duration_seconds: 3 });
    expect(inspectMedia(mp4(7), "clip.mp4")).toMatchObject({ mime: "video/mp4", kind: "video", duration_seconds: 7 });
    expect(inspectMedia(mp4(7, 1, 9000, "M4A "), "clip.m4a")).toMatchObject({ mime: "audio/mp4", kind: "audio", duration_seconds: 7 });
    expect(inspectMedia(png(320, 200), "shot.png")).toMatchObject({ mime: "image/png", kind: "image", width: 320, height: 200 });
    expect(inspectMedia(mp3ish(), "clip.mp3")).toMatchObject({ mime: "audio/mpeg", kind: "audio", readable: false });
    expect(inspectMedia(new Uint8Array(Buffer.from("hello world, plain text here")), "notes.txt")).toMatchObject({
      mime: "text/plain",
      kind: "text",
    });
    expect(inspectMedia(new Uint8Array(20), "blob.bin")).toMatchObject({ kind: "other", readable: true });
  });
});

describe("verifyWork", () => {
  it("passes good audio and prices it at the task's unit rate", async () => {
    const result = await run({
      job: AUDIO_TASK,
      work: [file("one.wav", "audio/wav", wav(10, 1)), file("two.wav", "audio/wav", wav(12, 2))],
      answers: { language: "English" },
    });
    expect(result.outcome).toBe("pass");
    expect(result.deterministic).toBe(true);
    expect(result.verdicts.map((v) => v.verifier)).toEqual(["requirements", "media", "duplicates"]);
    expect(result.accepted_units).toBe(2);
    expect(result.pay).toEqual({ amount: 1, currency: "USD" });
    expect(result.summary).toContain("Pass");
    expect(
      await run({
        job: AUDIO_TASK,
        work: [file("one.wav", "audio/wav", wav(10, 1)), file("two.wav", "audio/wav", wav(12, 2))],
        answers: { language: "English" },
      }),
    ).toEqual(result);
  });

  it("fails what the requirements rule out", async () => {
    const few = await run({ job: AUDIO_TASK, work: [file("one.wav", "audio/wav", wav(10))], answers: { language: "2" } });
    expect(few.outcome).toBe("fail");
    expect(few.pay).toBeUndefined();
    expect(few.verdicts[0]!.checks.find((c) => c.id === "count")).toMatchObject({
      ok: false,
      message: expect.stringContaining("1 more needed"),
    });

    const wrongKind = await run({
      job: AUDIO_TASK,
      work: [file("a.wav", "audio/wav", wav(10, 1)), file("photo.png", "image/png", png(640, 480))],
      answers: { language: "English" },
    });
    expect(wrongKind.verdicts[0]!.checks.find((c) => c.id === "kind" && c.file === "photo.png")).toMatchObject({
      ok: false,
      message: expect.stringContaining("this task takes audio"),
    });

    const unanswered = await run({
      job: AUDIO_TASK,
      work: [file("a.wav", "audio/wav", wav(10, 1)), file("b.wav", "audio/wav", wav(10, 2))],
    });
    expect(unanswered.summary).toContain("Not answered");
    const badOption = await run({
      job: AUDIO_TASK,
      work: [file("a.wav", "audio/wav", wav(10, 1)), file("b.wav", "audio/wav", wav(10, 2))],
      answers: { language: "Klingon" },
    });
    expect(badOption.summary).toContain("is not one of English / Twi / French");
  });

  it("fails media that is too long, too short, mislabelled or tiny", async () => {
    const long = await run({
      job: AUDIO_TASK,
      work: [file("a.wav", "audio/wav", wav(10, 1)), file("b.wav", "audio/wav", wav(45, 2))],
      answers: { language: "English" },
    });
    expect(long.outcome).toBe("fail");
    expect(long.summary).toContain("45 s; the limit is 30 s");
    const mislabelled = await run({
      job: AUDIO_TASK,
      work: [file("a.wav", "audio/wav", wav(10, 1)), file("b.mp3", "audio/mpeg", png(640, 480, 2))],
      answers: { language: "English" },
    });
    expect(mislabelled.summary).toContain("says audio/mpeg but its bytes are image/png");
    const tiny = await run({
      job: AUDIO_TASK,
      work: [file("a.wav", "audio/wav", wav(10, 1)), file("b.wav", "audio/wav", wav(0.4, 2))],
      answers: { language: "English" },
    });
    expect(tiny.summary).toContain("too small");
    const small = await run({
      job: IMAGE_TASK,
      work: [
        file("1.png", "image/png", png(640, 480, 1)),
        file("2.jpg", "image/jpeg", jpeg(800, 600, 2)),
        file("3.png", "image/png", png(100, 80, 3)),
      ],
    });
    expect(small.outcome).toBe("fail");
    expect(small.summary).toContain("100×80");
    const video = await run({
      job: VIDEO_TASK,
      work: [file("a.mp4", "video/mp4", mp4(30, 1)), file("b.mov", "video/quicktime", mp4(59, 2, 9000, "qt  "))],
    });
    expect(video.outcome).toBe("pass");
    expect(video.pay).toEqual({ amount: 2, currency: "USD" });
  });

  it("is uncertain when a duration cannot be read, and pays nothing", async () => {
    const result = await run({
      job: AUDIO_TASK,
      work: [file("a.wav", "audio/wav", wav(10, 1)), file("b.mp3", "audio/mpeg", mp3ish(2))],
      answers: { language: "English" },
    });
    expect(result.outcome).toBe("uncertain");
    expect(result.pay).toBeUndefined();
    expect(result.summary).toContain("a person should look");
    expect(result.verdicts.find((v) => v.verifier === "media")?.checks.find((c) => c.file === "b.mp3")).toMatchObject({
      ok: true,
      details: { readable: false },
    });
  });

  it("catches duplicates within the batch and resubmissions", async () => {
    const twice = await run({
      job: AUDIO_TASK,
      work: [file("a.wav", "audio/wav", wav(10, 1)), file("b.wav", "audio/wav", wav(10, 1))],
      answers: { language: "English" },
    });
    expect(twice.outcome).toBe("fail");
    expect(twice.summary).toContain("b.wav is the same as a.wav");
    const known = new Set([fingerprint(file("a.wav", "audio/wav", wav(10, 1)))]);
    const again = await run(
      {
        job: AUDIO_TASK,
        work: [file("a.wav", "audio/wav", wav(10, 1)), file("b.wav", "audio/wav", wav(10, 2))],
        answers: { language: "English" },
      },
      builtInVerifiers,
      { known_fingerprints: known },
    );
    expect(again.summary).toContain("a.wav was already accepted before");
  });

  it("judges written answers", async () => {
    const good = await run({ job: TEXT_TASK, work: [textWork("Positive: the customer says they will come back, which is praise.")] });
    expect(good.outcome).toBe("pass");
    expect(good.verdicts.map((v) => v.verifier)).toEqual(["requirements", "duplicates", "text"]);
    expect(good.pay).toEqual({ amount: 2, currency: "USD" });
    expect((await run({ job: TEXT_TASK, work: [textWork("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")] })).summary).toContain(
      "does not read like an answer",
    );
    expect((await run({ job: TEXT_TASK, work: [textWork("Text A: 'Great service, will come back.'")] })).summary).toContain("pasted back");
    expect((await run({ job: TEXT_TASK, work: [textWork("too short")] })).summary).toContain("at least 20 needed");
    expect((await run({ job: TEXT_TASK, work: [file("a.wav", "audio/wav", wav(5))] })).summary).toContain("this task takes text");
  });

  it("marks a crashing verifier uncertain and a non-deterministic one as needing a person", async () => {
    const crashing = defineVerifier({
      id: "crashy",
      name: "Crashy",
      description: "throws",
      deterministic: true,
      verify: () => {
        throw new Error("kaboom");
      },
    });
    const flaky = defineVerifier({
      id: "flaky",
      name: "Flaky",
      description: "a model",
      deterministic: false,
      verify: () => ({ verifier: "flaky", outcome: "pass", checks: [] }),
    });
    const work = [file("a.wav", "audio/wav", wav(10, 1)), file("b.wav", "audio/wav", wav(10, 2))];
    const crashed = await run({ job: AUDIO_TASK, work, answers: { language: "English" } }, [...builtInVerifiers, crashing]);
    expect(crashed.outcome).toBe("uncertain");
    expect(crashed.verdicts.find((v) => v.verifier === "crashy")?.checks[0]).toMatchObject({
      id: "verifier_error",
      message: expect.stringContaining("kaboom"),
    });
    const soft = await run({ job: AUDIO_TASK, work, answers: { language: "English" } }, [...builtInVerifiers, flaky]);
    expect(soft.outcome).toBe("pass");
    expect(soft.deterministic).toBe(false);
    expect(soft.summary).toContain("a person decides");
    const none = await run({ job: AUDIO_TASK, work }, []);
    expect(none.outcome).toBe("uncertain");
    expect(none.summary).toContain("no verifier applies");
  });

  it("applies verifiers by media, connector and tag", () => {
    const audioOnly = defineVerifier({
      id: "a",
      name: "A",
      description: "d",
      deterministic: true,
      applies: { media: ["audio"] },
      verify: () => ({ verifier: "a", outcome: "pass", checks: [] }),
    });
    const kariaaOnly = defineVerifier({
      id: "k",
      name: "K",
      description: "d",
      deterministic: true,
      applies: { connectors: ["kariaa"] },
      verify: () => ({ verifier: "k", outcome: "pass", checks: [] }),
    });
    const tagged = defineVerifier({
      id: "t",
      name: "T",
      description: "d",
      deterministic: true,
      applies: { tags: ["voice"] },
      verify: () => ({ verifier: "t", outcome: "pass", checks: [] }),
    });
    expect(verifierApplies(audioOnly, AUDIO_TASK)).toBe(true);
    expect(verifierApplies(audioOnly, TEXT_TASK)).toBe(false);
    expect(verifierApplies(kariaaOnly, AUDIO_TASK)).toBe(false);
    expect(verifierApplies(kariaaOnly, { ...AUDIO_TASK, connector: "kariaa", stages: [] })).toBe(true);
    expect(verifierApplies(tagged, { ...AUDIO_TASK, tags: ["voice"] })).toBe(true);
    expect(verifierApplies(tagged, AUDIO_TASK)).toBe(false);
    expect(() =>
      defineVerifier({
        id: "Bad",
        name: "x",
        description: "y",
        deterministic: true,
        verify: () => ({ verifier: "Bad", outcome: "pass", checks: [] }),
      }),
    ).toThrow(/Verifier id/u);
  });

  it("combines outcomes and prices units", () => {
    expect(combineOutcomes([])).toBe("uncertain");
    expect(combineOutcomes(["pass", "uncertain", "fail"])).toBe("fail");
    expect(combineOutcomes(["pass", "uncertain"])).toBe("uncertain");
    expect(combineOutcomes(["pass", "pass"])).toBe("pass");
    expect(payFor(AUDIO_TASK, 3)).toEqual({ amount: 1.5, currency: "USD" });
    expect(payFor({ ...AUDIO_TASK, pay: { min: 40000, period: "year", currency: "USD" } }, 2)).toBeUndefined();
    expect(payFor(AUDIO_TASK, 0)).toBeUndefined();
  });

  it("validates JSON deliverables against requirements.output_schema", async () => {
    const schemaTask = {
      ...TEXT_TASK,
      requirements: {
        output_schema: {
          type: "object",
          required: ["summary", "score", "status"],
          properties: {
            summary: { type: "string", minLength: 10 },
            score: { type: "number", minimum: 1 },
            status: { type: "string", enum: ["ready", "blocked"] },
            findings: { type: "array" },
          },
        },
      },
    };

    const validJson = JSON.stringify({
      summary: "Comprehensive market analysis completed.",
      score: 95,
      status: "ready",
      findings: ["item 1", "item 2"],
    });
    const passRes = await run({ job: schemaTask, work: [textWork(validJson)] });
    expect(passRes.outcome).toBe("pass");

    const invalidJson = JSON.stringify({
      summary: "short",
      score: 0,
      status: "unknown",
    });
    const failRes = await run({ job: schemaTask, work: [textWork(invalidJson)] });
    expect(failRes.outcome).toBe("fail");
    expect(failRes.verdicts[0]!.checks.some((c) => c.id === "output_schema:summary" && !c.ok)).toBe(true);
    expect(failRes.verdicts[0]!.checks.some((c) => c.id === "output_schema:score" && !c.ok)).toBe(true);
    expect(failRes.verdicts[0]!.checks.some((c) => c.id === "output_schema:status" && !c.ok)).toBe(true);
  });
});
