import { describeVerifierConformance } from "../../core/conformance.js";
import { AUDIO_TASK, IMAGE_TASK, file, mp3ish, png, wav } from "../../../tests/helpers/media.js";
import { media } from "./index.js";

describeVerifierConformance(media, {
  pass: { job: AUDIO_TASK, work: [file("a.wav", "audio/wav", wav(5, 1)), file("b.wav", "audio/wav", wav(29, 2))] },
  fail: { job: IMAGE_TASK, work: [file("tiny.png", "image/png", png(64, 64))] },
  uncertain: { job: AUDIO_TASK, work: [file("a.mp3", "audio/mpeg", mp3ish())] },
});
