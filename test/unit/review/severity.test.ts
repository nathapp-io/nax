import { describe, expect, test } from "bun:test";
import { isBlockingSeverity } from "../../../src/review/severity";

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

  test("unknown severity is NOT blocking at default threshold (0 rank < error rank of 2)", () => {
    expect(isBlockingSeverity("unknown")).toBe(false);
  });

  test("unknown severity IS blocking at info threshold (0 rank >= 0 rank)", () => {
    // info has rank 0, unknown maps to 0 via fallback — 0 >= 0 is true
    expect(isBlockingSeverity("unknown", "info")).toBe(true);
  });

  test("low is NOT blocking at default threshold (ranks below error)", () => {
    expect(isBlockingSeverity("low")).toBe(false);
  });
});
