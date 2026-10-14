import { describe, expect, test } from "bun:test";
import { reviewerCommandsSection } from "@/prompts";

describe("reviewerCommandsSection (nax#2500)", () => {
  test("is a fixed, non-overridable instructions section that says edits are reverted", () => {
    const s = reviewerCommandsSection();
    expect(s.id).toBe("reviewer-commands");
    expect(s.overridable).toBe(false);
    expect(s.content).toContain("check mode");
    expect(s.content).toContain("reverted");
    // US-006 (nax#2527): unchanged — the workflow story/branch prompts carry the gate results themselves.
    expect(s.content).toContain("you may run commands");
  });
});
