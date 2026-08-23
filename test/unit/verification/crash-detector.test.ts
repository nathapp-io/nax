/**
 * Crash Detector — BUG-070
 *
 * Unit tests for detectRuntimeCrash() and CRASH_PATTERNS.
 * These test the crash pattern matching logic in isolation.
 *
 * Tests are RED until src/verification/crash-detector.ts is implemented.
 */

import { describe, expect, test } from "bun:test";
import { CRASH_PATTERNS, detectRuntimeCrash } from "@/verification/crash-detector";
import { absentValue, nullValue } from "@test/helpers";

// ---------------------------------------------------------------------------
// CRASH_PATTERNS constant
// ---------------------------------------------------------------------------

describe("CRASH_PATTERNS", () => {
  test.each([
    ["panic(main thread)" as const],
    ["Segmentation fault" as const],
    ["Bun has crashed" as const],
    ["oh no: Bun has crashed" as const],
  ])("includes '%s'", (pattern) => {
    expect(CRASH_PATTERNS).toContain(pattern);
  });
});

// ---------------------------------------------------------------------------
// detectRuntimeCrash — panic(main thread)
// ---------------------------------------------------------------------------

describe("detectRuntimeCrash — panic(main thread)", () => {
  test("returns true for exact pattern", () => {
    expect(detectRuntimeCrash("panic(main thread)")).toBe(true);
  });

  test("returns true when pattern appears in multi-line output", () => {
    const output = ["Running tests...", "panic(main thread)", "runtime error: index out of range"].join("\n");
    expect(detectRuntimeCrash(output)).toBe(true);
  });

  test("returns true when pattern appears at end of output", () => {
    const output = "bun test v1.3.7\n\npanic(main thread)";
    expect(detectRuntimeCrash(output)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectRuntimeCrash — Segmentation fault
// ---------------------------------------------------------------------------

describe("detectRuntimeCrash — Segmentation fault", () => {
  test("returns true for exact pattern", () => {
    expect(detectRuntimeCrash("Segmentation fault")).toBe(true);
  });

  test("returns true with surrounding text", () => {
    const output = "bun test v1.3.7\nSegmentation fault (core dumped)\n";
    expect(detectRuntimeCrash(output)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectRuntimeCrash — Bun has crashed
// ---------------------------------------------------------------------------

describe("detectRuntimeCrash — Bun has crashed", () => {
  test("returns true for exact pattern", () => {
    expect(detectRuntimeCrash("Bun has crashed")).toBe(true);
  });

  test("returns true in realistic crash output", () => {
    const output = [
      "bun test v1.3.7 (7e4501e8)",
      "",
      "Bun has crashed. This is a bug in Bun.",
      "Please report it at https://github.com/oven-sh/bun/issues",
    ].join("\n");
    expect(detectRuntimeCrash(output)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectRuntimeCrash — oh no: Bun has crashed
// ---------------------------------------------------------------------------

describe("detectRuntimeCrash — oh no: Bun has crashed", () => {
  test("returns true for exact pattern", () => {
    expect(detectRuntimeCrash("oh no: Bun has crashed")).toBe(true);
  });

  test("returns true in full crash banner", () => {
    const output = ["oh no: Bun has crashed", "version: 1.3.7 (7e4501e8)", "platform: linux x64"].join("\n");
    expect(detectRuntimeCrash(output)).toBe(true);
  });

  test("matches when 'oh no: Bun has crashed' but not just 'Bun has crashed'", () => {
    // Both patterns should match independently
    expect(detectRuntimeCrash("oh no: Bun has crashed")).toBe(true);
    expect(detectRuntimeCrash("Bun has crashed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectRuntimeCrash — non-crash output
// ---------------------------------------------------------------------------

describe("detectRuntimeCrash — non-crash output", () => {
  test("returns false for normal test failure output", () => {
    const output = [
      "bun test v1.3.7",
      "",
      "test/unit/foo.test.ts:",
      "  x it should do something (2ms)",
      "    error: Expected 1 to equal 2",
      "",
      "1 fail",
      "5 pass",
    ].join("\n");
    expect(detectRuntimeCrash(output)).toBe(false);
  });

  test("returns false for passing test output", () => {
    const output = [
      "bun test v1.3.7",
      "",
      "test/unit/foo.test.ts:",
      "  (pass) it should do something (1ms)",
      "",
      "6 pass",
    ].join("\n");
    expect(detectRuntimeCrash(output)).toBe(false);
  });

  test.each([
    ["timeout output", "Test suite exceeded 30 second timeout\n"],
    ["empty string", ""],
    ["undefined", absentValue<string>()],
    ["null", nullValue<string>()],
    ["partial 'panic' without full pattern", "don't panic, everything is fine"],
    ["partial 'crashed' without Bun prefix", "The test process crashed unexpectedly"],
  ])("returns false for %s", (_label, output) => {
    expect(detectRuntimeCrash(output)).toBe(false);
  });
});
