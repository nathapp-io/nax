/**
 * US-FLAKE-PROBE: flakeDetection config schema defaults (AC1)
 *
 * Confirms that NaxConfigSchema parses `execution.flakeDetection` with the
 * required defaults when unset, and that mergePackageConfig preserves
 * per-package overrides of the subtree.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type NaxConfig, NaxConfigSchema, mergePackageConfig } from "@/config";

describe("execution.flakeDetection schema defaults (AC1)", () => {
  test("DEFAULT_CONFIG.execution.flakeDetection.enabled is true", () => {
    expect(DEFAULT_CONFIG.execution.flakeDetection.enabled).toBe(true);
  });

  test("DEFAULT_CONFIG.execution.flakeDetection.probeRuns is 2", () => {
    expect(DEFAULT_CONFIG.execution.flakeDetection.probeRuns).toBe(2);
  });

  test("DEFAULT_CONFIG.execution.flakeDetection.maxProbesPerGate is 5", () => {
    expect(DEFAULT_CONFIG.execution.flakeDetection.maxProbesPerGate).toBe(5);
  });

  test("DEFAULT_CONFIG.execution.flakeDetection.probeTimeoutSeconds is 60", () => {
    expect(DEFAULT_CONFIG.execution.flakeDetection.probeTimeoutSeconds).toBe(60);
  });

  test("NaxConfigSchema.parse({}) yields the same flakeDetection defaults", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.execution.flakeDetection.enabled).toBe(true);
    expect(parsed.execution.flakeDetection.probeRuns).toBe(2);
    expect(parsed.execution.flakeDetection.maxProbesPerGate).toBe(5);
    expect(parsed.execution.flakeDetection.probeTimeoutSeconds).toBe(60);
  });

  test("accepts a partial package-level override of flakeDetection", () => {
    const root: NaxConfig = {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { test: "bun test" },
      },
    };
    const override: Partial<NaxConfig> = {
      execution: {
        ...DEFAULT_CONFIG.execution,
        flakeDetection: {
          enabled: false,
          probeRuns: 4,
          maxProbesPerGate: 8,
          probeTimeoutSeconds: 120,
        },
      },
    };
    const merged = mergePackageConfig(root, override);

    expect(merged.execution.flakeDetection.enabled).toBe(false);
    expect(merged.execution.flakeDetection.probeRuns).toBe(4);
    expect(merged.execution.flakeDetection.maxProbesPerGate).toBe(8);
    expect(merged.execution.flakeDetection.probeTimeoutSeconds).toBe(120);
  });

  test("partial package override keeps root defaults for unspecified fields", () => {
    const root: NaxConfig = {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { test: "bun test" },
      },
    };
    const override: Partial<NaxConfig> = {
      execution: {
        ...DEFAULT_CONFIG.execution,
        flakeDetection: {
          ...DEFAULT_CONFIG.execution.flakeDetection,
          probeRuns: 4,
        },
      },
    };
    const merged = mergePackageConfig(root, override);

    expect(merged.execution.flakeDetection.probeRuns).toBe(4);
    expect(merged.execution.flakeDetection.enabled).toBe(true);
    expect(merged.execution.flakeDetection.maxProbesPerGate).toBe(5);
    expect(merged.execution.flakeDetection.probeTimeoutSeconds).toBe(60);
  });
});
