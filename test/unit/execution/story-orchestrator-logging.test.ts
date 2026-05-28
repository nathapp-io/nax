import { describe, expect, test } from "bun:test";
import { formatPhaseResultMessage } from "@/execution";

describe("formatPhaseResultMessage — stage-aware messaging", () => {
  test("returns 'Phase passed' for a non-rectification op with success=true", () => {
    expect(formatPhaseResultMessage("verifier", true)).toBe("Phase passed: verifier");
  });

  test("returns 'Phase failed' for a non-rectification op with success=false", () => {
    expect(formatPhaseResultMessage("verifier", false)).toBe("Phase failed: verifier");
  });

  test("returns 'Rectification strategy completed' for a rectification-stage op regardless of success flag", () => {
    expect(formatPhaseResultMessage("autofix-implementer", false, "rectification")).toBe(
      "Rectification strategy completed: autofix-implementer",
    );
    expect(formatPhaseResultMessage("autofix-test-writer", true, "rectification")).toBe(
      "Rectification strategy completed: autofix-test-writer",
    );
  });

  test("keeps the greenfield-gate carve-out", () => {
    expect(formatPhaseResultMessage("greenfield-gate", true)).toBe(
      "Greenfield-gate: pre-existing tests detected (not greenfield) — proceeding with normal TDD",
    );
    expect(formatPhaseResultMessage("greenfield-gate", false)).toBe(
      "Greenfield-gate: no pre-existing tests — greenfield run, pausing TDD test-writer",
    );
  });
});
