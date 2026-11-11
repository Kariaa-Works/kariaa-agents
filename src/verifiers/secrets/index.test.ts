import { describe, expect, it } from "vitest";
import { describeVerifierConformance } from "../../core/conformance.js";
import { TEXT_TASK, file, textWork, wav } from "../../../tests/helpers/media.js";
import { secrets, secretsIn } from "./index.js";

// Built here so the repo holds nothing shaped like a real key.
const FAKE_KEY = `kra_${"a1b2c3d4".repeat(3)}`;
const FAKE_TOKEN = `ghp_${"Zx9".repeat(12)}`;

describeVerifierConformance(secrets, {
  pass: { job: TEXT_TASK, work: [textWork("Positive: the customer praises the service and plans to return.")] },
  fail: { job: TEXT_TASK, work: [textWork(`Here is my config: KARIAA_API_KEY=${FAKE_KEY}`)] },
});

describe("secrets", () => {
  it("names the kind of key and never repeats it", async () => {
    const verdict = await secrets.verify({ job: TEXT_TASK, work: [textWork(`token ${FAKE_TOKEN}`)], answers: {} });
    expect(verdict.outcome).toBe("fail");
    expect(verdict.checks[0]!.message).toContain("a GitHub token");
    expect(JSON.stringify(verdict)).not.toContain(FAKE_TOKEN);
  });

  it("reads text files and leaves media alone", async () => {
    const env = new TextEncoder().encode(`KEY=${FAKE_KEY}
`);
    const verdict = await secrets.verify({
      job: TEXT_TASK,
      work: [file("notes.txt", "text/plain", env), file("clip.wav", "audio/wav", wav(2))],
      answers: {},
    });
    expect(verdict.outcome).toBe("fail");
    expect(verdict.accepted_units).toBe(1);
    expect(verdict.checks.map((c) => c.file)).toEqual(["notes.txt"]);
  });

  it("does not mistake ordinary words for keys", () => {
    expect(secretsIn("The task asks for a skeleton key metaphor, a risk-free summary and a token of thanks.")).toEqual([]);
  });
});
