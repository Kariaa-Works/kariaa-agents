import { describe, expect, it } from "vitest";
import { describeVerifierConformance } from "../../core/conformance.js";
import { TEXT_TASK, textWork } from "../../../tests/helpers/media.js";
import { links, unreachable } from "./index.js";

describeVerifierConformance(links, {
  pass: { job: TEXT_TASK, work: [textWork("The fix is in https://github.com/octocat/hello-world/pull/42 and the notes are below.")] },
  fail: { job: TEXT_TASK, work: [textWork("Delivered here: http://localhost:3000/report and https://github.com/your-repo/pull/1")] },
});

describe("links", () => {
  it("says why a link cannot be opened by anyone else", () => {
    expect(unreachable("https://github.com/octocat/hello-world/pull/42")).toBeUndefined();
    expect(unreachable("https://docs.google.com/document/d/abc123/edit")).toBeUndefined();
    expect(unreachable("http://github.com/octocat/hello-world")).toBe("is not https");
    expect(unreachable("https://localhost:8080/")).toBe("is a placeholder or a local address");
    expect(unreachable("https://example.com/report")).toBe("is a placeholder or a local address");
    expect(unreachable("https://192.168.1.20/report")).toBe("points at a private address");
    expect(unreachable("https://intranet/report")).toBe("has no public host name");
    expect(unreachable("file:///C:/work/report.pdf")).toBe("is a file on your machine");
    expect(unreachable("https://github.com/<user>/repo")).toBe("still has a placeholder in it");
  });

  it("names each bad link once and passes an answer with no links", async () => {
    const bad = await links.verify({
      job: TEXT_TASK,
      work: [textWork("See http://localhost:3000/a, then http://localhost:3000/a again."), textWork("No links here, only the answer.")],
      answers: {},
    });
    expect(bad.outcome).toBe("fail");
    expect(bad.checks.filter((c) => !c.ok)).toHaveLength(1);
    expect(bad.accepted_units).toBe(1);

    const none = await links.verify({ job: TEXT_TASK, work: [textWork("Positive: the customer praises the service.")], answers: {} });
    expect(none).toMatchObject({ outcome: "pass", checks: [], accepted_units: 1 });
  });
});
