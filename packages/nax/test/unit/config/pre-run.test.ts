/**
 * US-003 — `execution.preRun`: the config key that declares blocking host-side
 * setup steps. Covers the schema shape (`command` non-empty, `timeoutSeconds`
 * a positive integer defaulting to 300), the `[]` no-op default, and the fact
 * that the outer `NaxConfigSchema` default literal carries `preRun` too (BUG-20:
 * zod does not re-parse a `.default()` value, so omitting the key there leaves
 * `execution.preRun` undefined under `NaxConfigSchema.parse({})`).
 *
 * `NaxConfigSchema` rejects a bare partial `execution` object — the required
 * fields (`maxIterations`, `costLimit`, …) have no field-level defaults — so
 * the override tests seed the merged base the loader itself starts from, the
 * same way `bash-approval.test.ts` pins its default.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, NaxConfigSchema } from "@/config";

/** A raw config whose `execution` block is the real default plus one override. */
function configWithPreRun(preRun: unknown): Record<string, unknown> {
  return { execution: { ...DEFAULT_CONFIG.execution, preRun } };
}

describe("execution.preRun schema", () => {
  test("AC-1: NaxConfigSchema.parse({}) yields execution.preRun = []", () => {
    expect(NaxConfigSchema.parse({}).execution.preRun).toEqual([]);
    // The derived DEFAULT_CONFIG takes the same path, so it keeps the same value.
    expect(DEFAULT_CONFIG.execution.preRun).toEqual([]);
  });

  test("AC-2: a step without timeoutSeconds resolves to 300", () => {
    const parsed = NaxConfigSchema.parse(configWithPreRun([{ command: "true" }]));

    expect(parsed.execution.preRun).toEqual([{ command: "true", timeoutSeconds: 300 }]);
  });

  test("AC-2: an explicit timeoutSeconds survives", () => {
    const parsed = NaxConfigSchema.parse(configWithPreRun([{ command: "up", timeoutSeconds: 7 }]));

    expect(parsed.execution.preRun).toEqual([{ command: "up", timeoutSeconds: 7 }]);
  });

  test("AC-3: an empty command fails validation", () => {
    expect(() => NaxConfigSchema.parse(configWithPreRun([{ command: "" }]))).toThrow();
  });

  test.each([0, -1, 1.5])("AC-4: timeoutSeconds %p fails validation", (timeoutSeconds) => {
    expect(() => NaxConfigSchema.parse(configWithPreRun([{ command: "up", timeoutSeconds }]))).toThrow();
  });
});
