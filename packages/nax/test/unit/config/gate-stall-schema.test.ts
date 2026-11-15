/**
 * US-002 — the `quality.stallDetection` configuration surface.
 *
 * The block carries two independent detectors, each disabled by its zero
 * value: repetition (a runaway loop echoing one line) and silence (a command
 * that has stopped emitting anything). Silence defaults to 0 on purpose —
 * quiet compilers and tests are legitimate, so only repetition is on out of
 * the box.
 *
 * Both defaults are READ FROM the leaf's `DEFAULT_GATE_STALL_POLICY`; these
 * tests pin the resolved numbers, which is the only runtime-observable part of
 * that single-source requirement.
 */

import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import { NaxConfigSchema } from "@/config/schemas";
import { SparseStallDetectionConfigSchema, StallDetectionConfigSchema } from "@/config/schemas-execution";

describe("NaxConfigSchema quality.stallDetection defaults (US-002)", () => {
  test("AC-1: parse with quality absent resolves repeatedLineThreshold to 100", () => {
    const parsed = NaxConfigSchema.parse({});
    assertDefined(parsed.quality.stallDetection, "quality.stallDetection");
    expect(parsed.quality.stallDetection.repeatedLineThreshold).toBe(100);
  });

  test("AC-2: parse with quality absent resolves silenceTimeoutSeconds to 0", () => {
    const parsed = NaxConfigSchema.parse({});
    assertDefined(parsed.quality.stallDetection, "quality.stallDetection");
    expect(parsed.quality.stallDetection.silenceTimeoutSeconds).toBe(0);
  });

  test("AC-3: an empty quality block resolves the same policy as an absent one", () => {
    const absent = NaxConfigSchema.parse({});
    const empty = NaxConfigSchema.parse({ quality: {} });
    assertDefined(empty.quality.stallDetection, "parsed quality.stallDetection");
    expect(empty.quality.stallDetection).toEqual(absent.quality.stallDetection);
    expect(empty.quality.stallDetection).toEqual({ repeatedLineThreshold: 100, silenceTimeoutSeconds: 0 });
  });
});

describe("StallDetectionConfigSchema.repeatedLineThreshold (US-002)", () => {
  test("AC-4: accepts 0, which disables repetition detection", () => {
    const result = StallDetectionConfigSchema.safeParse({ repeatedLineThreshold: 0 });
    expect(result.success).toBe(true);
    expect(result.data?.repeatedLineThreshold).toBe(0);
  });

  test.each([2, 3, 100, 1000] as const)("AC-5: accepts the integer threshold %p (>= 2)", (threshold) => {
    const result = StallDetectionConfigSchema.safeParse({ repeatedLineThreshold: threshold });
    expect(result.success).toBe(true);
    expect(result.data?.repeatedLineThreshold).toBe(threshold);
  });

  test.each([
    ["one (a single line is not a repetition)", 1],
    ["a negative integer", -1],
    ["a large negative integer", -100],
    ["a fraction", 2.5],
    ["a numeric string", "100"],
    ["a boolean true", true],
    ["a boolean false", false],
    ["null", null],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ] as const)("AC-6: rejects %s", (_label, value) => {
    const result = StallDetectionConfigSchema.safeParse({ repeatedLineThreshold: value });
    expect(result.success).toBe(false);
  });
});

describe("StallDetectionConfigSchema.silenceTimeoutSeconds (US-002)", () => {
  test.each([0, 1, 30, 600] as const)("AC-7: accepts %p seconds (0 disables, positive opts in)", (seconds) => {
    const result = StallDetectionConfigSchema.safeParse({ silenceTimeoutSeconds: seconds });
    expect(result.success).toBe(true);
    expect(result.data?.silenceTimeoutSeconds).toBe(seconds);
  });

  test.each([
    ["a negative integer", -1],
    ["a large negative integer", -30],
    ["a fraction", 1.5],
    ["a numeric string", "10"],
    ["null", null],
    ["a boolean true", true],
    ["a boolean false", false],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ] as const)("AC-8: rejects %s", (_label, value) => {
    const result = StallDetectionConfigSchema.safeParse({ silenceTimeoutSeconds: value });
    expect(result.success).toBe(false);
  });

  test("configuring one detector leaves the other disabled and needs no enable switch", () => {
    // A config that sets only the repetition threshold keeps silence off — the
    // zero value is the switch, and an `enabled` key is not part of the shape.
    const parsed = NaxConfigSchema.parse({ quality: { stallDetection: { repeatedLineThreshold: 5 } } });
    expect(parsed.quality.stallDetection).toEqual({ repeatedLineThreshold: 5, silenceTimeoutSeconds: 0 });

    const withStraySwitch = NaxConfigSchema.parse({
      quality: { stallDetection: { repeatedLineThreshold: 5, enabled: true } },
    });
    expect(withStraySwitch.quality.stallDetection).toEqual({ repeatedLineThreshold: 5, silenceTimeoutSeconds: 0 });
  });
});

describe("SparseStallDetectionConfigSchema — a DECLARED policy (B4)", () => {
  /**
   * A package overlay is read by `loadPackageOverride`, which returns declared
   * values unparsed, so the finish gate validates the sparse block itself. The
   * schema must reject what the full one rejects while leaving absent fields
   * absent: a default here would overwrite the sibling the overlay meant to
   * inherit from the root config.
   */
  test("leaves absent detectors absent instead of defaulting them", () => {
    expect(SparseStallDetectionConfigSchema.parse({})).toEqual({});
    expect(SparseStallDetectionConfigSchema.parse({ repeatedLineThreshold: 40 })).toEqual({
      repeatedLineThreshold: 40,
    });
    expect(SparseStallDetectionConfigSchema.parse({ silenceTimeoutSeconds: 0 })).toEqual({
      silenceTimeoutSeconds: 0,
    });
  });

  test("keeps an explicit both-zero policy", () => {
    expect(SparseStallDetectionConfigSchema.parse({ repeatedLineThreshold: 0, silenceTimeoutSeconds: 0 })).toEqual({
      repeatedLineThreshold: 0,
      silenceTimeoutSeconds: 0,
    });
  });

  test.each([
    ["repeatedLineThreshold: 1", { repeatedLineThreshold: 1 }],
    ["repeatedLineThreshold: -1", { repeatedLineThreshold: -1 }],
    ["silenceTimeoutSeconds: -7", { silenceTimeoutSeconds: -7 }],
    ["a numeric string", { silenceTimeoutSeconds: "10" }],
    ["null", null],
    ["a bare number", 7],
  ] as const)("rejects %s", (_label, value) => {
    expect(SparseStallDetectionConfigSchema.safeParse(value).success).toBe(false);
  });
});
