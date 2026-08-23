/**
 * US-001 (mutation-check): execution.mutationCheck schema defaults, per-package
 * merge, and `mutation-check` selector coverage (AC1–AC6).
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  type MutationCheckConfig,
  type NaxConfig,
  NaxConfigSchema,
  mergePackageConfig,
  mutationCheckConfigSelector,
} from "@/config";

describe("execution.mutationCheck schema defaults (AC1–AC3)", () => {
  test("DEFAULT_CONFIG.execution.mutationCheck.enabled is false", () => {
    expect(DEFAULT_CONFIG.execution.mutationCheck.enabled).toBe(false);
  });

  test("DEFAULT_CONFIG.execution.mutationCheck.maxMutants is 3", () => {
    expect(DEFAULT_CONFIG.execution.mutationCheck.maxMutants).toBe(3);
  });

  test("DEFAULT_CONFIG.execution.mutationCheck.timeoutSeconds is a positive integer", () => {
    const v = DEFAULT_CONFIG.execution.mutationCheck.timeoutSeconds;
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });

  test("NaxConfigSchema.parse({}) yields the same mutationCheck defaults", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.execution.mutationCheck.enabled).toBe(false);
    expect(parsed.execution.mutationCheck.maxMutants).toBe(3);
    expect(Number.isInteger(parsed.execution.mutationCheck.timeoutSeconds)).toBe(true);
    expect(parsed.execution.mutationCheck.timeoutSeconds).toBeGreaterThan(0);
  });
});

describe("execution.mutationCheck user override (AC4)", () => {
  test("maxMutants=5 is preserved after parse", () => {
    const parsed = NaxConfigSchema.parse({
      execution: {
        maxIterations: 10,
        iterationDelayMs: 2000,
        costLimit: 30,
        maxStoriesPerFeature: 500,
        rectification: {},
        regressionGate: {},
        smartTestRunner: true,
        mutationCheck: { maxMutants: 5 },
      },
    });
    expect(parsed.execution.mutationCheck.maxMutants).toBe(5);
  });
});

describe("mergePackageConfig — execution.mutationCheck (AC5)", () => {
  function makeRoot(): NaxConfig {
    return {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { test: "bun test" },
      },
    };
  }

  test("per-package enabled=true overrides root enabled=false; maxMutants retains root/default", () => {
    const root = makeRoot();
    // Sanity-check root defaults before merge
    expect(root.execution.mutationCheck.enabled).toBe(false);
    expect(root.execution.mutationCheck.maxMutants).toBe(3);

    const result = mergePackageConfig(root, {
      execution: {
        ...DEFAULT_CONFIG.execution,
        mutationCheck: { enabled: true } as Partial<NaxConfig["execution"]["mutationCheck"]>,
      } as Partial<NaxConfig["execution"]>,
    } as Partial<NaxConfig>);

    expect(result.execution.mutationCheck.enabled).toBe(true);
    // maxMutants retains the root default of 3
    expect(result.execution.mutationCheck.maxMutants).toBe(3);
  });

  test("partial per-package override keeps root defaults for unspecified fields", () => {
    const root: NaxConfig = {
      ...makeRoot(),
      execution: {
        ...DEFAULT_CONFIG.execution,
        mutationCheck: {
          enabled: false,
          maxMutants: 7,
          timeoutSeconds: 90,
        },
      },
    };

    const result = mergePackageConfig(root, {
      execution: {
        ...DEFAULT_CONFIG.execution,
        mutationCheck: { maxMutants: 9 } as Partial<NaxConfig["execution"]["mutationCheck"]>,
      } as Partial<NaxConfig["execution"]>,
    } as Partial<NaxConfig>);

    expect(result.execution.mutationCheck.maxMutants).toBe(9);
    expect(result.execution.mutationCheck.enabled).toBe(false);
    expect(result.execution.mutationCheck.timeoutSeconds).toBe(90);
  });
});

describe("mutation-check selector (AC6)", () => {
  test("returns an object with enabled, maxMutants, timeoutSeconds", () => {
    const slice: MutationCheckConfig = mutationCheckConfigSelector.select(DEFAULT_CONFIG);
    expect(slice).toHaveProperty("enabled");
    expect(slice).toHaveProperty("maxMutants");
    expect(slice).toHaveProperty("timeoutSeconds");
  });

  test("selector name is 'mutation-check'", () => {
    expect(mutationCheckConfigSelector.name).toBe("mutation-check");
  });

  test("default slice matches DEFAULT_CONFIG.execution.mutationCheck", () => {
    const slice = mutationCheckConfigSelector.select(DEFAULT_CONFIG);
    expect(slice).toEqual(DEFAULT_CONFIG.execution.mutationCheck);
  });
});
