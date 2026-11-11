import { describe, expect, it } from "vitest";
import { ProtocolError } from "../src/core/errors.js";
import { isConnectorId, makeId, parseId } from "../src/core/ids.js";

describe("ids", () => {
  it("round-trips, keeping colons inside the native id", () => {
    expect(makeId("kariaa", "3f2a")).toBe("kariaa:3f2a");
    expect(parseId("kariaa:3f2a")).toEqual({ connector: "kariaa", native: "3f2a" });
    expect(parseId("himalayas:https://himalayas.app/x")).toEqual({ connector: "himalayas", native: "https://himalayas.app/x" });
  });

  it("rejects ids without a connector part", () => {
    for (const bad of ["", "nocolon", ":x", "kariaa:", "Bad:x", "a b:x"]) {
      expect(() => parseId(bad)).toThrow(ProtocolError);
      try {
        parseId(bad);
      } catch (error) {
        expect((error as ProtocolError).code).toBe("invalid_input");
      }
    }
  });

  it("validates connector ids", () => {
    expect(isConnectorId("kariaa-jobs")).toBe(true);
    expect(isConnectorId("a1")).toBe(true);
    expect(isConnectorId("-a")).toBe(false);
    expect(isConnectorId("Kariaa")).toBe(false);
    expect(isConnectorId("a_b")).toBe(false);
  });
});
