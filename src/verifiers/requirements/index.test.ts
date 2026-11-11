import { describe, expect, it } from "vitest";
import { describeVerifierConformance } from "../../core/conformance.js";
import { AUDIO_TASK, file, wav } from "../../../tests/helpers/media.js";
import { matchOption, requirements } from "./index.js";

describeVerifierConformance(requirements, {
  pass: {
    job: AUDIO_TASK,
    work: [file("a.wav", "audio/wav", wav(5, 1)), file("b.wav", "audio/wav", wav(5, 2))],
    answers: { language: "Twi" },
  },
  fail: { job: AUDIO_TASK, work: [file("a.wav", "audio/wav", wav(5, 1))], answers: { language: "Twi" } },
});

describe("matchOption", () => {
  it("takes the text, the number, or a unique prefix", () => {
    const options = ["English", "Twi", "French"];
    expect(matchOption(options, "twi")).toBe("Twi");
    expect(matchOption(options, "3")).toBe("French");
    expect(matchOption(options, "Eng")).toBe("English");
    expect(matchOption(options, "Klingon")).toBeUndefined();
    expect(matchOption(options, "T")).toBeUndefined();
  });

  it("accepts PDF and DOCX files when requirements.files.kinds lists document extensions", () => {
    const docJob = {
      ...AUDIO_TASK,
      requirements: {
        files: {
          kinds: ["pdf", "doc", "docx", "txt", "rtf"],
          count: 1,
        },
      },
    };
    const pdfBytes = new Uint8Array(Buffer.from("%PDF-1.4 sample resume content"));
    const verdict = requirements.verify({
      job: docJob,
      work: [file("resume.pdf", "application/pdf", pdfBytes)],
    });
    expect(verdict.outcome).toBe("pass");
  });
});
