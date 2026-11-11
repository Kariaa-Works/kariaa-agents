import { describe, expect, it } from "vitest";
import { defineConnector } from "../src/core/connector.js";
import { ProtocolError } from "../src/core/errors.js";
import { ConnectorHealth } from "../src/core/health.js";
import { WorkProtocol } from "../src/core/router.js";

describe("connector health", () => {
  it("takes a platform out after three platform failures, probes it, and puts it back on the first answer", () => {
    let now = 0;
    const events: string[] = [];
    const h = new ConnectorHealth({ now: () => now, log: (e) => events.push(e) });
    h.failed("x", "timeout");
    h.failed("x", "auth_required"); // one person's key: not the platform
    h.failed("x", "rate_limited");
    h.failed("x", "upstream_error");
    expect(h.status("x")).toBe("ok");
    h.failed("x", "upstream_error");
    expect(h.status("x")).toBe("down");
    expect(events).toEqual(["health.down"]);
    expect(h.shouldAsk("x")).toBe(false);
    now += 10 * 60 * 1000;
    expect(h.shouldAsk("x")).toBe(true); // the probe
    expect(h.shouldAsk("x")).toBe(false); // only one per interval
    h.ok("x");
    expect(h.status("x")).toBe("ok");
    expect(h.shouldAsk("x")).toBe(true);
    expect(events).toEqual(["health.down", "health.up"]);
    expect(h.report()[0]).toMatchObject({ connector: "x", status: "ok", failures: 0 });
  });

  it("leaves a failing platform out of catalog searches but still asks it when named", async () => {
    let calls = 0;
    let broken = true;
    const flaky = defineConnector({
      id: "flaky",
      name: "Flaky",
      description: "Test.",
      kinds: ["task"],
      tier: "self",
      auth: { type: "none" },
      async search() {
        calls += 1;
        if (broken) throw new ProtocolError("upstream_error", "Flaky is down.");
        return { jobs: [{ id: "f1", kind: "task", title: "Task", url: "https://flaky.example/f1" }] };
      },
    });
    const steady = defineConnector({
      id: "steady",
      name: "Steady",
      description: "Test.",
      kinds: ["task"],
      tier: "self",
      auth: { type: "none" },
      async search() {
        return { jobs: [{ id: "s1", kind: "task", title: "Task", url: "https://steady.example/s1" }] };
      },
    });
    let now = 0;
    const health = new ConnectorHealth({ now: () => now });
    const p = new WorkProtocol({ connectors: [flaky, steady], env: {}, cache: null, health });
    for (let i = 0; i < 3; i += 1) await p.search({});
    expect(calls).toBe(3);
    expect(p.connectors().find((c) => c.id === "flaky")?.health).toBe("down");

    const skipped = await p.search({});
    expect(calls).toBe(3);
    expect(skipped.jobs.map((j) => j.id)).toEqual(["steady:s1"]);
    expect(skipped.partial).toEqual([]);

    await p.search({ connectors: ["flaky"] });
    expect(calls).toBe(4); // named: asked anyway

    broken = false;
    now += 10 * 60 * 1000;
    const probed = await p.search({});
    expect(calls).toBe(5);
    expect(probed.jobs.map((j) => j.id).sort()).toEqual(["flaky:f1", "steady:s1"]);
    expect(p.connectors().find((c) => c.id === "flaky")?.health).toBeUndefined();
  });
});
