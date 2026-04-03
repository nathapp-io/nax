import { describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "../../../src/cli/config-descriptions";

describe("FIELD_DESCRIPTIONS acceptance model discoverability (issue #225)", () => {
  test("acceptance.model description exists and mentions model tiers", () => {
    const description = FIELD_DESCRIPTIONS["acceptance.model"];
    expect(typeof description).toBe("string");
    expect(description.length).toBeGreaterThan(0);
    expect(description.toLowerCase()).toContain("fast");
    expect(description.toLowerCase()).toContain("balanced");
    expect(description.toLowerCase()).toContain("powerful");
  });

  test("acceptance.refinement description exists and explains behavior", () => {
    const description = FIELD_DESCRIPTIONS["acceptance.refinement"];
    expect(typeof description).toBe("string");
    expect(description.length).toBeGreaterThan(0);
    expect(description.toLowerCase()).toContain("refinement");
    expect(description.toLowerCase()).toContain("default");
  });
});
