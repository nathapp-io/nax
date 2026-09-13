import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { ExecutionConfigSchema } from "@/config/schemas-execution";

const base = {
  maxIterations: 10,
  iterationDelayMs: 0,
  costLimit: 5,
  maxStoriesPerFeature: 10,
  rectification: {},
  regressionGate: {},
};

describe("execution.commandInterceptor", () => {
  test("defaults to disabled with the measured verbs", () => {
    const parsed = ExecutionConfigSchema.parse(base);
    expect(parsed.commandInterceptor.enabled).toBe(false);
    expect(parsed.commandInterceptor.provider).toBe("rtk");
    expect(parsed.commandInterceptor.git.verbs).toEqual(["log", "diff"]);
  });

  test("has no failuresBeforeDisable key", () => {
    // There is no per-request I/O to fail: preflight runs once at construction
    // and a rewrite is a pure string prefix. A circuit breaker would be a
    // config key that can never fire. See Task 5.
    expect(() => ExecutionConfigSchema.parse({ ...base, commandInterceptor: { failuresBeforeDisable: 3 } })).toThrow();
  });

  test("an empty verb list is valid and intercepts nothing", () => {
    const parsed = ExecutionConfigSchema.parse({ ...base, commandInterceptor: { git: { verbs: [] } } });
    expect(parsed.commandInterceptor.git.verbs).toEqual([]);
  });

  test("rejects an unknown key rather than stripping it", () => {
    expect(() => ExecutionConfigSchema.parse({ ...base, commandInterceptor: { sites: ["git"] } })).toThrow();
  });

  test("the full NaxConfig default carries the block (BUG-20 shadowing)", () => {
    // The inner-schema tests above cannot catch this: a field added to
    // ExecutionConfigSchema but forgotten in the outer NaxConfigSchema
    // `execution` default literal silently vanishes from
    // NaxConfigSchema.parse({}) / DEFAULT_CONFIG, while resolving fine for a
    // config that supplies `execution` partially. setupRun's install reads
    // config.execution.commandInterceptor, so a missing field would crash
    // every run that relies on the default.
    expect(DEFAULT_CONFIG.execution.commandInterceptor).toBeDefined();
    expect(DEFAULT_CONFIG.execution.commandInterceptor.enabled).toBe(false);
  });
});
