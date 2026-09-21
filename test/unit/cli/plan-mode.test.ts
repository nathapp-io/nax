/**
 * Tests for resolvePlanMode() in planCommand().
 * Split from plan.test.ts to stay within the 600-line file limit.
 * Covers the surviving plan.mode schema arms: "single" and "refine".
 */

import { describe, expect, test } from "bun:test";
import { resolvePlanMode } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";

function makeMinimalConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return { ...DEFAULT_CONFIG, ...overrides } as NaxConfig;
}

describe("resolvePlanMode", () => {
  test("explicit plan.mode single returns single", () => {
    const config = makeMinimalConfig({ plan: { ...DEFAULT_CONFIG.plan, mode: "single" } });
    expect(resolvePlanMode(config)).toBe("single");
  });

  test("explicit plan.mode refine returns refine", () => {
    const config = makeMinimalConfig({ plan: { ...DEFAULT_CONFIG.plan, mode: "refine" } });
    expect(resolvePlanMode(config)).toBe("refine");
  });

  test("no plan.mode returns single", () => {
    expect(resolvePlanMode({} as NaxConfig)).toBe("single");
  });
});
