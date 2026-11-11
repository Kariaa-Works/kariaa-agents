import { describeVerifierConformance } from "../../core/conformance.js";
import { TEXT_TASK, textWork } from "../../../tests/helpers/media.js";
import { text } from "./index.js";

describeVerifierConformance(text, {
  pass: { job: TEXT_TASK, work: [textWork("Positive: the customer praises the service and plans to return.")] },
  fail: { job: TEXT_TASK, work: [textWork("qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")] },
});
