/**
 * `execution.commandSafety.guard` (P5 A-mode): the opt-in flag-for-review block.
 *
 * The guard reuses the shadow's classifier, so a `guard` with no `shadow` is a
 * validation error rather than a silently dead config; the threshold is the
 * flag-for-review cut, greater than 0 and at most 1, defaulting to 0.75.
 */
import { describe, expect, test } from "bun:test";
import { CommandSafetyConfigSchema } from "@/config";

const SHADOW = { url: "http://127.0.0.1:8020/x" };

/** Every issue of a failed parse, as a dotted key path, for asserting WHERE it failed. */
function issuePaths(error: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] }): string[] {
  return error.issues.map((issue) => issue.path.map(String).join("."));
}

describe("execution.commandSafety.guard", () => {
  test("AC1: parses with the 0.75 default threshold when the shadow is present", () => {
    const parsed = CommandSafetyConfigSchema.parse({ shadow: SHADOW, guard: {} });

    expect(parsed.guard?.threshold).toBe(0.75);
  });

  test("AC2: a guard with no shadow fails with the reuse-classifier message", () => {
    const result = CommandSafetyConfigSchema.safeParse({ guard: { threshold: 0.6 } });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected safeParse to fail for a guard without a shadow");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "commandSafety.guard requires commandSafety.shadow (the guard reuses its classifier)",
    );
  });

  test("AC3: a threshold above 1 fails on guard.threshold", () => {
    const result = CommandSafetyConfigSchema.safeParse({ shadow: SHADOW, guard: { threshold: 1.5 } });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected safeParse to fail for threshold 1.5");
    expect(issuePaths(result.error)).toContain("guard.threshold");
  });

  test("AC4: a threshold of 0 fails on guard.threshold; it must be greater than 0", () => {
    const result = CommandSafetyConfigSchema.safeParse({ shadow: SHADOW, guard: { threshold: 0 } });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected safeParse to fail for threshold 0");
    expect(issuePaths(result.error)).toContain("guard.threshold");
  });

  test("AC6: guard is optional — absent from a shadow-only config, kept when present", () => {
    expect(CommandSafetyConfigSchema.parse({ shadow: SHADOW }).guard).toBeUndefined();
    expect(CommandSafetyConfigSchema.parse({ shadow: SHADOW, guard: { threshold: 0.6 } }).guard?.threshold).toBe(0.6);
  });
});

describe("execution.commandSafety.guard — threshold bounds (0, 1]", () => {
  test.each([1, 0.75, 0.6, 0.0001])("a threshold of %p parses and is kept verbatim", (threshold) => {
    const parsed = CommandSafetyConfigSchema.parse({ shadow: SHADOW, guard: { threshold } });

    expect(parsed.guard?.threshold).toBe(threshold);
  });

  test.each([1.5, 2, -0.5, 0])("a threshold of %p is rejected", (threshold) => {
    expect(CommandSafetyConfigSchema.safeParse({ shadow: SHADOW, guard: { threshold } }).success).toBe(false);
  });
});
