import { describe, expect, test } from "bun:test";
import { isBlockingSeverity, normalizeSeverity } from "@/review/severity";

describe("isBlockingSeverity — SSOT in src/review/severity.ts", () => {
  test("error is blocking at default threshold", () => {
    expect(isBlockingSeverity("error")).toBe(true);
  });

  test("critical is blocking at default threshold", () => {
    expect(isBlockingSeverity("critical")).toBe(true);
  });

  test("warning is NOT blocking at default threshold (error)", () => {
    expect(isBlockingSeverity("warning")).toBe(false);
  });

  test("info is NOT blocking at default threshold", () => {
    expect(isBlockingSeverity("info")).toBe(false);
  });

  test("unverifiable is NOT blocking (ranks same as info)", () => {
    expect(isBlockingSeverity("unverifiable")).toBe(false);
  });

  test("warning IS blocking when threshold='warning'", () => {
    expect(isBlockingSeverity("warning", "warning")).toBe(true);
  });

  test("info IS blocking when threshold='info'", () => {
    expect(isBlockingSeverity("info", "info")).toBe(true);
  });

  test("error IS blocking when threshold='warning'", () => {
    expect(isBlockingSeverity("error", "warning")).toBe(true);
  });

  test("info is NOT blocking when threshold='warning'", () => {
    expect(isBlockingSeverity("info", "warning")).toBe(false);
  });

  // BUG-2: an unrecognized severity string must fail CLOSED (normalizes to
  // "error", not the advisory "info") — a model emitting an unrecognized
  // vocabulary word must not silently demote a finding below the gate.
  test("unknown severity IS blocking at default threshold (normalizes to error, fail-closed)", () => {
    expect(isBlockingSeverity("unknown")).toBe(true);
  });

  test("unknown severity IS blocking at info threshold too", () => {
    expect(isBlockingSeverity("unknown", "info")).toBe(true);
  });

  test("low is NOT blocking at default threshold (ranks below error)", () => {
    expect(isBlockingSeverity("low")).toBe(false);
  });

  // BUG-2: case-sensitivity was the original fail-open bug — capitalized
  // severities from an LLM must not silently rank as advisory.
  test("capitalized severity is blocking (case-insensitive)", () => {
    expect(isBlockingSeverity("Critical")).toBe(true);
  });
});

describe("normalizeSeverity", () => {
  test("is case-insensitive", () => {
    expect(normalizeSeverity("Critical")).toBe("critical");
    expect(normalizeSeverity("CRITICAL")).toBe("critical");
  });

  test("maps high-end synonyms", () => {
    expect(normalizeSeverity("BLOCKER")).toBe("critical");
    expect(normalizeSeverity("severe")).toBe("critical");
    expect(normalizeSeverity("fatal")).toBe("critical");
    expect(normalizeSeverity("high")).toBe("error");
    expect(normalizeSeverity("major")).toBe("error");
  });

  test("maps low-end synonyms to info, not error (would otherwise flood the gate)", () => {
    expect(normalizeSeverity("nit")).toBe("info");
    expect(normalizeSeverity("minor")).toBe("info");
    expect(normalizeSeverity("suggestion")).toBe("info");
    expect(normalizeSeverity("trivial")).toBe("info");
    expect(normalizeSeverity("note")).toBe("info");
  });

  test("maps mid synonyms to warning", () => {
    expect(normalizeSeverity("warn")).toBe("warning");
    expect(normalizeSeverity("medium")).toBe("warning");
    expect(normalizeSeverity("moderate")).toBe("warning");
  });

  test("maps unverifiable synonyms", () => {
    expect(normalizeSeverity("unconfirmed")).toBe("unverifiable");
    expect(normalizeSeverity("unverified")).toBe("unverifiable");
  });

  test("unrecognized value fails closed to error, not info", () => {
    expect(normalizeSeverity("banana")).toBe("error");
  });
});
