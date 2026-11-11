import { describeVerifierConformance } from "../../core/conformance.js";
import { AUDIO_TASK, TEXT_TASK, file, textWork, wav } from "../../../tests/helpers/media.js";
import { duplicates } from "./index.js";

describeVerifierConformance(duplicates, {
  pass: { job: AUDIO_TASK, work: [file("a.wav", "audio/wav", wav(5, 1)), file("b.wav", "audio/wav", wav(5, 2))] },
  fail: { job: TEXT_TASK, work: [textWork("The same answer twice over."), textWork("the same   answer twice over.")] },
});
