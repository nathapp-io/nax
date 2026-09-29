import { describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
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

/**
 * US-002 — the Bash site's opt-in. Interception changes what the agent sees, so
 * `bash` is a second, narrower switch: `enabled` is the master, `bash` only
 * decides whether the model-authored Bash string is routed through the provider.
 */
describe("execution.commandInterceptor.bash (US-002)", () => {
  test("US-002 AC1: no commandInterceptor at all yields bash.enabled === false", () => {
    const parsed = ExecutionConfigSchema.parse(base);
    // Asserted as the whole object first: an absent `bash` then fails here
    // rather than throwing on a property read.
    expect(parsed.commandInterceptor.bash).toEqual({ enabled: false });
  });

  test("US-002 AC3: bash.enabled === true parses under an enabled parent", () => {
    const parsed = ExecutionConfigSchema.parse({
      ...base,
      commandInterceptor: { enabled: true, bash: { enabled: true } },
    });
    expect(parsed.commandInterceptor.bash).toEqual({ enabled: true });
  });

  test("US-002 AC4 (boundary): a DISABLED bash under a disabled parent is accepted", () => {
    // Only the contradiction is a config error; `bash.enabled: false` alongside
    // `enabled: false` must stay a valid, inert config.
    const parsed = ExecutionConfigSchema.safeParse({
      ...base,
      commandInterceptor: { enabled: false, bash: { enabled: false } },
    });
    expect(parsed.success).toBe(true);
  });

  test("US-002 AC4: rejects bash.enabled === true while the master switch is off", () => {
    const parsed = ExecutionConfigSchema.safeParse({
      ...base,
      commandInterceptor: { enabled: false, bash: { enabled: true } },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain(
        "execution.commandInterceptor.bash.enabled requires execution.commandInterceptor.enabled",
      );
    }
  });

  test("US-002 AC5: rejects an unknown key inside bash", () => {
    const parsed = ExecutionConfigSchema.safeParse({
      ...base,
      commandInterceptor: { enabled: true, bash: { enabled: true, unexpected: true } },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  test("US-002 AC2: DEFAULT_CONFIG carries bash.enabled === false", () => {
    expect(DEFAULT_CONFIG.execution.commandInterceptor.bash).toEqual({ enabled: false });
  });

  test("US-002 AC6: the field has a non-empty description", () => {
    const description = FIELD_DESCRIPTIONS["execution.commandInterceptor.bash.enabled"];
    expect(typeof description).toBe("string");
    expect((description ?? "").trim().length).toBeGreaterThan(0);
  });
});
