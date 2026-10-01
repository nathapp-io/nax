// test/protocols/thinking.test.ts
import { describe, expect, it } from "vitest";
import { clampThinkingLevel } from "../../src/protocols/thinking.ts";

describe("clampThinkingLevel", () => {
  it("returns the requested level when supported", () => {
    expect(clampThinkingLevel("high", ["off", "low", "high"])).toBe("high");
  });

  it("clamps down to the nearest lower level", () => {
    expect(clampThinkingLevel("max", ["off", "low", "medium"])).toBe("medium");
  });

  it("clamps up when nothing lower exists", () => {
    expect(clampThinkingLevel("minimal", ["medium", "high"])).toBe("medium");
  });

  it("prefers the lower neighbour on a tie", () => {
    // "low"(2) is equidistant from "minimal"(1) and "medium"(3). Prefer lower:
    // spending fewer thinking tokens than asked is the safer surprise.
    expect(clampThinkingLevel("low", ["minimal", "medium"])).toBe("minimal");
  });

  it("honours the lower-neighbour tie rule on unsorted input", () => {
    // "low" is 3 ranks from neither "medium"(3) nor "minimal"(1); the sort
    // guarantees "minimal" wins even though it is listed last.
    expect(clampThinkingLevel("low", ["medium", "minimal"])).toBe("minimal");
  });

  it("returns off when the model supports no thinking", () => {
    expect(clampThinkingLevel("high", [])).toBe("off");
  });
});
