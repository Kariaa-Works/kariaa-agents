import { describeVerifierConformance } from "../../core/conformance.js";
import { AUDIO_TASK, file, wav } from "../../../tests/helpers/media.js";
import { exampleVerifier } from "./index.js";

describeVerifierConformance(exampleVerifier, {
  pass: { job: AUDIO_TASK, work: [file("a.wav", "audio/wav", wav(5))] },
  fail: { job: AUDIO_TASK, work: [file("empty.wav", "audio/wav", new Uint8Array(0))] },
});
