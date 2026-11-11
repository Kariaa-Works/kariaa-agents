import { describe, expect, it } from "vitest";
import { defineConnector } from "./connector.js";
import { credentialsFor, isConfigured } from "./credentials.js";

const oauth = defineConnector({
  id: "upwork",
  name: "Upwork",
  description: "probe",
  kinds: ["listing"],
  auth: { type: "oauth", help: "work login upwork", required: true },
  async account() {
    return { signed_in: true };
  },
});

describe("per-request credentials", () => {
  it("uses a vault OAuth token and does not treat the operator's files as a hosted sign-in", () => {
    const bag = credentialsFor(oauth, { WORK_HOSTED: "1" }, { WORK_OAUTH_ACCESS_TOKEN: "tok" });
    expect(bag.WORK_OAUTH_ACCESS_TOKEN).toBe("tok");
    expect(bag.WORK_HOSTED).toBe("1");
    expect(isConfigured(oauth, bag, { WORK_HOSTED: "1" })).toBe(true);
    expect(isConfigured(oauth, { WORK_HOSTED: "1" }, { WORK_HOSTED: "1" })).toBe(false);
  });

  it("counts a source as configured when any one of its credential sets is complete", () => {
    const store = defineConnector({
      id: "store",
      name: "Store",
      description: "probe",
      kinds: ["task"],
      auth: {
        type: "api_key",
        env: ["SHOP", "TOKEN", "ID", "SECRET"],
        anyOf: [
          ["SHOP", "TOKEN"],
          ["SHOP", "ID", "SECRET"],
        ],
        help: "key",
      },
      async account() {
        return { signed_in: true };
      },
    });
    expect(isConfigured(store, { SHOP: "a", TOKEN: "t" })).toBe(true);
    expect(isConfigured(store, { SHOP: "a", ID: "i", SECRET: "s" })).toBe(true);
    expect(isConfigured(store, { SHOP: "a", ID: "i" })).toBe(false);
    expect(isConfigured(store, { TOKEN: "t" })).toBe(false);
  });

  it("does not copy a process-wide OAuth token onto every connector", () => {
    const bag = credentialsFor(oauth, { WORK_OAUTH_ACCESS_TOKEN: "global" }, {});
    expect(bag.WORK_OAUTH_ACCESS_TOKEN).toBeUndefined();
  });
});
