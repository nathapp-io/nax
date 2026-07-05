import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Test helpers ────────────────────────────────────────────────────────────

function mergeDeep(target: any, source: any): any {
  if (source === undefined || source === null) return target;
  const result: any = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = mergeDeep(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Parse NaxConfigSchema applying overrides via deep merge over schema defaults.
 * NaxConfigSchema.parse({}) fills in all defaults. We then deep-merge overrides
 * so callers only need to specify the fields they care about.
 */
function parseConfig(schema: any, overrides: any = {}): any {
  const defaults = schema.parse({});
  if (Object.keys(overrides).length === 0) return defaults;
  return mergeDeep(defaults, overrides);
}

/** Build a minimal CallContext with the given mutationCheck overrides */
function makeCtx(mutationCheckOverrides: Record<string, unknown> = {}): any {
  const { NaxConfigSchema } = require("../../../src/config/schemas");
  const config = parseConfig(NaxConfigSchema, {
    execution: { mutationCheck: { ...mutationCheckOverrides } },
  });
  return { config, storyId: "test-story" };
}

/** Minimal MutationCheckInput for op tests */
function makeInput(overrides: Record<string, unknown> = {}): any {
  return {
    story: { id: "s1", title: "Story One", description: "D", acceptanceCriteria: [] },
    workdir: "/tmp/nax-test-workdir",
    storyId: "s1",
    resolvedTestPatterns: {
      regex: [],
      pathspec: [],
      globs: [],
      testDirs: [],
      resolution: "default",
    },
    ...overrides,
  };
}

// ─── US-001: Config sub-tree ─────────────────────────────────────────────────

describe("US-001: Config sub-tree", () => {
  test("AC-1: parseConfig(schema, {}).execution.mutationCheck.enabled === false", () => {
    const { NaxConfigSchema } = require("../../../src/config/schemas");
    const config = parseConfig(NaxConfigSchema, {});
    expect(config.execution.mutationCheck.enabled).toBe(false);
  });

  test("AC-2: parseConfig(schema, {}).execution.mutationCheck.maxMutants === 3", () => {
    const { NaxConfigSchema } = require("../../../src/config/schemas");
    const config = parseConfig(NaxConfigSchema, {});
    expect(config.execution.mutationCheck.maxMutants).toBe(3);
  });

  test("AC-3: parseConfig(schema, {}).execution.mutationCheck.timeoutSeconds is a positive integer", () => {
    const { NaxConfigSchema } = require("../../../src/config/schemas");
    const config = parseConfig(NaxConfigSchema, {});
    const timeout = config.execution.mutationCheck.timeoutSeconds;
    expect(Number.isInteger(timeout)).toBe(true);
    expect(timeout).toBeGreaterThan(0);
  });

  test("AC-4: explicit maxMutants override yields resolved maxMutants === 5", () => {
    const { NaxConfigSchema } = require("../../../src/config/schemas");
    const config = parseConfig(NaxConfigSchema, { execution: { mutationCheck: { maxMutants: 5 } } });
    expect(config.execution.mutationCheck.maxMutants).toBe(5);
  });

  test("AC-5: mergePackageConfig field-wise spreads mutationCheck — enabled flips, maxMutants retains root value", () => {
    const { mergePackageConfig } = require("../../../src/config");
    const { NaxConfigSchema } = require("../../../src/config/schemas");
    const root = parseConfig(NaxConfigSchema, {
      execution: { mutationCheck: { enabled: false, maxMutants: 3 } },
    });
    const merged = mergePackageConfig(root, { execution: { mutationCheck: { enabled: true } } });
    expect(merged.execution.mutationCheck.enabled).toBe(true);
    expect(merged.execution.mutationCheck.maxMutants).toBe(3);
  });

  test("AC-6: mutationCheckConfigSelector.select(parsedConfig) exposes enabled, maxMutants, timeoutSeconds", () => {
    const { mutationCheckConfigSelector } = require("../../../src/config/selectors");
    const { NaxConfigSchema } = require("../../../src/config/schemas");
    const config = parseConfig(NaxConfigSchema, {});
    const selected = mutationCheckConfigSelector.select(config);
    const own = (k: string) => Object.prototype.hasOwnProperty.call(selected, k);
    expect(own("enabled")).toBe(true);
    expect(own("maxMutants")).toBe(true);
    expect(own("timeoutSeconds")).toBe(true);
  });
});

// ─── US-002: Mutation generation ─────────────────────────────────────────────

describe("US-002: Mutation generation", () => {
  test("AC-7: generateMutants('a > b', 'typescript') returns Mutant with after==='a < b' and comparison operatorId", async () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = await generateMutants("a > b", "typescript");
    expect(Array.isArray(result)).toBe(true);
    const flip = result.find((m: any) => m.after === "a < b");
    expect(flip).toBeDefined();
    expect(/comparison|relational|inequality/i.test(flip!.operatorId)).toBe(true);
  });

  test("AC-8: generateMutants('const x = true', 'typescript') returns Mutant with after==='const x = false'", async () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = await generateMutants("const x = true", "typescript");
    expect(Array.isArray(result)).toBe(true);
    const boolMutant = result.find((m: any) => m.after === "const x = false");
    expect(boolMutant).toBeDefined();
  });

  test("AC-9: generateMutants('x + y', 'typescript') returns Mutant with after==='x - y'", async () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = await generateMutants("x + y", "typescript");
    expect(Array.isArray(result)).toBe(true);
    const arithMutant = result.find((m: any) => m.after === "x - y");
    expect(arithMutant).toBeDefined();
  });

  test("AC-10: each Mutant exposes file (string), line (number >= 1), before, after, operatorId (all strings)", async () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = await generateMutants("a > b", "typescript");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const m of result) {
      expect(typeof m.file).toBe("string");
      expect(typeof m.line).toBe("number");
      expect(m.line).toBeGreaterThanOrEqual(1);
      expect(typeof m.before).toBe("string");
      expect(typeof m.after).toBe("string");
      expect(typeof m.operatorId).toBe("string");
    }
  });

  test("AC-11: generateMutants('a > b', 'python') returns empty array", async () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = await generateMutants("a > b", "python");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test("AC-12: generateMutants('a > b', 'go') returns empty array", async () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = await generateMutants("a > b", "go");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test("AC-13: generateMutants('a > b', undefined) returns empty array", async () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = await generateMutants("a > b", undefined);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  test("AC-14: generateMutants with 10 matchable lines and max=3 returns at most 3 mutants", async () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const source = Array.from({ length: 10 }, () => "a > b").join("\n");
    const result = await generateMutants(source, "typescript", { max: 3 });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test("AC-15: generateMutants('const x = 1; const y = 2;', 'typescript') returns empty array", async () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = await generateMutants("const x = 1; const y = 2;", "typescript");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

// ─── US-003: Mutation apply & classify ───────────────────────────────────────

describe("US-003: Mutation apply & classify", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-mutation-ac-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test("AC-16: applyMutant writes m.after at line m.line in the target file", async () => {
    const { generateMutants, applyMutant } = require("../../../src/verification/mutation");
    const source = "a > b";
    const filePath = join(tempDir, "apply-test.ts");
    await Bun.write(filePath, source);

    const mutants = await generateMutants(source, "typescript");
    expect(mutants.length).toBeGreaterThan(0);
    const m = mutants[0];

    await applyMutant({ filePath, line: m.line, before: m.before, after: m.after });

    const content = await Bun.file(filePath).text();
    const lines = content.split("\n");
    expect(lines[m.line - 1]).toBe(m.after);
  });

  test("AC-17: applyMutant then revertMutant leaves file byte-for-byte identical to original", async () => {
    const { generateMutants, applyMutant, revertMutant } = require("../../../src/verification/mutation");
    const source = "a > b";
    const filePath = join(tempDir, "revert-test.ts");
    await Bun.write(filePath, source);

    const original = await Bun.file(filePath).arrayBuffer();
    const mutants = await generateMutants(source, "typescript");
    expect(mutants.length).toBeGreaterThan(0);
    const m = mutants[0];

    await applyMutant({ filePath, line: m.line, before: m.before, after: m.after });
    await revertMutant({ filePath, line: m.line, before: m.before, after: m.after });

    const current = await Bun.file(filePath).arrayBuffer();
    expect(Buffer.from(original).equals(Buffer.from(current))).toBe(true);
  });

  test("AC-18: classifyMutant({ status: 'TEST_FAILURE' }) === 'killed'", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "TEST_FAILURE" })).toBe("killed");
  });

  test("AC-19: classifyMutant({ status: 'SUCCESS' }) === 'survived'", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "SUCCESS" })).toBe("survived");
  });

  test("AC-20: classifyMutant returns 'errored' for ENVIRONMENTAL_FAILURE, ASSET_CHECK_FAILED, and TIMEOUT", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "ENVIRONMENTAL_FAILURE" })).toBe("errored");
    expect(classifyMutant({ status: "ASSET_CHECK_FAILED" })).toBe("errored");
    expect(classifyMutant({ status: "TIMEOUT" })).toBe("errored");
  });
});

// ─── US-004: mutationCheckOp ─────────────────────────────────────────────────

describe("US-004: mutationCheckOp", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-op-ac-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test("AC-21: mutationCheckOp.kind === 'deterministic', .name === 'mutation-check', .stage === 'verify'", () => {
    const { mutationCheckOp } = require("../../../src/operations");
    expect(mutationCheckOp.kind).toBe("deterministic");
    expect(mutationCheckOp.name).toBe("mutation-check");
    expect(mutationCheckOp.stage).toBe("verify");
  });

  test("AC-22: enabled=false returns {success:true, survivors:[]} without invoking selectScopedTests or regression", async () => {
    const { mutationCheckOp } = require("../../../src/operations");
    const ctx = makeCtx({ enabled: false });
    const input = makeInput({ workdir: tempDir });

    const selectCalls: unknown[] = [];
    const regressionCalls: unknown[] = [];
    const mockDeps = {
      detectLanguage: async () => "typescript",
      getChangedNonTestFiles: async () => [],
      selectScopedTests: async (a: unknown) => {
        selectCalls.push(a);
        return { effectiveCommand: "bun test" };
      },
      regression: async (a: unknown) => {
        regressionCalls.push(a);
        return { status: "SUCCESS" };
      },
    };

    const result = await mutationCheckOp.execute(input, ctx, mockDeps);
    expect(result).toEqual({ success: true, survivors: [] });
    expect(selectCalls.length).toBe(0);
    expect(regressionCalls.length).toBe(0);
  });

  test("AC-23: regression returns SUCCESS → survivor with file/line/operatorId in result", async () => {
    const { mutationCheckOp } = require("../../../src/operations");
    const ctx = makeCtx({ enabled: true, maxMutants: 10 });

    const sourceFile = join(tempDir, "source.ts");
    await Bun.write(sourceFile, "a > b");

    const mockDeps = {
      detectLanguage: async () => "typescript",
      getChangedNonTestFiles: async () => [sourceFile],
      selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
      regression: async () => ({ status: "SUCCESS" }),
    };

    const result = await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.survivors)).toBe(true);
    expect(result.survivors.length).toBeGreaterThan(0);

    const s = result.survivors[0];
    expect(typeof s.file).toBe("string");
    expect(typeof s.line).toBe("number");
    expect(typeof s.operatorId).toBe("string");
  });

  test("AC-24: regression returns TEST_FAILURE → mutant killed, survivors is empty", async () => {
    const { mutationCheckOp } = require("../../../src/operations");
    const ctx = makeCtx({ enabled: true, maxMutants: 10 });

    const sourceFile = join(tempDir, "killed.ts");
    await Bun.write(sourceFile, "a > b");

    const mockDeps = {
      detectLanguage: async () => "typescript",
      getChangedNonTestFiles: async () => [sourceFile],
      selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
      regression: async () => ({ status: "TEST_FAILURE" }),
    };

    const result = await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
    expect(result.success).toBe(true);
    expect(result.survivors).toEqual([]);
  });

  test("AC-25: regression returns TIMEOUT → errored mutant not counted as survivor", async () => {
    const { mutationCheckOp } = require("../../../src/operations");
    const ctx = makeCtx({ enabled: true, maxMutants: 10 });

    const sourceFile = join(tempDir, "timeout.ts");
    await Bun.write(sourceFile, "a > b");

    const mockDeps = {
      detectLanguage: async () => "typescript",
      getChangedNonTestFiles: async () => [sourceFile],
      selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
      regression: async () => ({ status: "TIMEOUT" }),
    };

    const result = await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
    expect(result.success).toBe(true);
    expect(result.survivors).toEqual([]);
  });

  test("AC-26: python language → success:true/survivors:[] and regression never called", async () => {
    const { mutationCheckOp } = require("../../../src/operations");
    const ctx = makeCtx({ enabled: true, maxMutants: 10 });

    let regressionCalled = false;
    const mockDeps = {
      detectLanguage: async () => "python",
      getChangedNonTestFiles: async () => [join(tempDir, "script.py")],
      selectScopedTests: async () => ({ effectiveCommand: "pytest" }),
      regression: async () => {
        regressionCalled = true;
        return { status: "SUCCESS" };
      },
    };

    const result = await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
    expect(result.success).toBe(true);
    expect(result.survivors).toEqual([]);
    expect(regressionCalled).toBe(false);
  });

  test("AC-27: maxMutants=2 → regression invoked at most 2 times despite 5+ candidate mutants", async () => {
    const { mutationCheckOp } = require("../../../src/operations");
    const ctx = makeCtx({ enabled: true, maxMutants: 2 });

    const sourceFile = join(tempDir, "many.ts");
    const lines = Array.from(
      { length: 10 },
      (_, i) => `const x${i} = a${i} > b${i};`,
    ).join("\n");
    await Bun.write(sourceFile, lines);

    let regressionCallCount = 0;
    const mockDeps = {
      detectLanguage: async () => "typescript",
      getChangedNonTestFiles: async () => [sourceFile],
      selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
      regression: async () => {
        regressionCallCount++;
        return { status: "TEST_FAILURE" };
      },
    };

    await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
    expect(regressionCallCount).toBeLessThanOrEqual(2);
  });

  test("AC-28: SEAM — selectScopedTests called with storyGitRef+file; regression called with effectiveCommand", async () => {
    const { mutationCheckOp } = require("../../../src/operations");
    const ctx = makeCtx({ enabled: true, maxMutants: 1 });

    const sourceFile = join(tempDir, "seam.ts");
    await Bun.write(sourceFile, "a > b");

    const storyGitRef = "abc123ref";
    const effectiveCommand = "bun test --filter seam";
    const capturedSelectInputs: any[] = [];
    const capturedRegressionInputs: any[] = [];

    const mockDeps = {
      detectLanguage: async () => "typescript",
      getChangedNonTestFiles: async () => [sourceFile],
      selectScopedTests: async (args: any) => {
        capturedSelectInputs.push(args);
        return { effectiveCommand };
      },
      regression: async (args: any) => {
        capturedRegressionInputs.push(args);
        return { status: "TEST_FAILURE" };
      },
    };

    await mutationCheckOp.execute(makeInput({ workdir: tempDir, storyGitRef }), ctx, mockDeps);

    expect(capturedSelectInputs.length).toBeGreaterThan(0);
    expect(capturedSelectInputs[0].storyGitRef).toBe(storyGitRef);
    expect(capturedSelectInputs[0].file).toBe(sourceFile);

    expect(capturedRegressionInputs.length).toBeGreaterThan(0);
    expect(capturedRegressionInputs[0].command).toBe(effectiveCommand);
  });

  test("AC-29: regression throw → file restored to original bytes and success:true returned", async () => {
    const { mutationCheckOp } = require("../../../src/operations");
    const ctx = makeCtx({ enabled: true, maxMutants: 1 });

    const sourceFile = join(tempDir, "throw-test.ts");
    const originalContent = "a > b";
    await Bun.write(sourceFile, originalContent);

    const mockDeps = {
      detectLanguage: async () => "typescript",
      getChangedNonTestFiles: async () => [sourceFile],
      selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
      regression: async () => {
        throw new Error("regression crashed unexpectedly");
      },
    };

    const result = await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);

    expect(result.success).toBe(true);
    expect(result.survivors).toEqual([]);

    const restoredContent = await Bun.file(sourceFile).text();
    expect(restoredContent).toBe(originalContent);
  });
});

// ─── US-005: Phase integration ───────────────────────────────────────────────

describe("US-005: Phase integration", () => {
  test("AC-30: 'mutation-check' is at the index immediately following 'full-suite-gate' in CANONICAL_ORDER", () => {
    const { CANONICAL_ORDER } = require("../../../src/execution/story-orchestrator/types");
    const idxFullSuiteGate = CANONICAL_ORDER.indexOf("full-suite-gate");
    const idxMutationCheck = CANONICAL_ORDER.indexOf("mutation-check");
    expect(idxFullSuiteGate).toBeGreaterThanOrEqual(0);
    expect(idxMutationCheck).toBe(
      idxFullSuiteGate + 1,
      `mutation-check at ${idxMutationCheck}, expected ${idxFullSuiteGate + 1}`,
    );
  });

  test("AC-31: PHASE_KIND_TO_STATE_KEY['mutation-check'] === 'mutationCheck' and InternalBuildState accepts it", () => {
    const { PHASE_KIND_TO_STATE_KEY } = require("../../../src/execution/story-orchestrator/types");
    expect(PHASE_KIND_TO_STATE_KEY["mutation-check"]).toBe("mutationCheck");
  });

  test("AC-32: STRICT_VERDICT_PHASE_NAMES.has('mutation-check') === false", () => {
    const { STRICT_VERDICT_PHASE_NAMES } = require("../../../src/execution/story-orchestrator/types");
    expect(STRICT_VERDICT_PHASE_NAMES.has("mutation-check")).toBe(false);
  });

  test("AC-33: builder executes phases in canonical order (full-suite-gate → mutation-check → verifier) regardless of add order", () => {
    const { StoryOrchestratorBuilder } = require("../../../src/execution/story-orchestrator/builder");
    const ops = require("../../../src/operations");
    const { NaxConfigSchema } = require("../../../src/config/schemas");
    const config = parseConfig(NaxConfigSchema, {});

    // Add in non-canonical order; canonical ordering must still hold in phaseNames()
    const builder = new StoryOrchestratorBuilder();
    builder
      .addMutationCheck({ op: ops.mutationCheckOp, input: {} })
      .addImplementer({ op: ops.implementerOp, input: {} })
      .addFullSuiteGate({ op: ops.fullSuiteGateOp, input: {} })
      .addVerifier({ op: ops.verifierOp, input: {} });

    const plan = builder.build({ config, storyId: "test" } as any, { isThreeSession: true });
    const phases = plan.phaseNames();

    const fsIdx = phases.indexOf("full-suite-gate");
    const mcIdx = phases.indexOf("mutation-check");
    const vrIdx = phases.indexOf("verifier");

    expect(fsIdx).toBeGreaterThanOrEqual(0);
    expect(mcIdx).toBeGreaterThan(fsIdx);
    expect(vrIdx).toBeGreaterThan(mcIdx);
  });

  test("AC-34: buildPlanForStrategy includes 'mutation-check' iff PlanInputs.mutationCheck is present", async () => {
    const { buildPlanForStrategy } = require("../../../src/execution/build-plan-for-strategy");
    const ops = require("../../../src/operations");
    const { NaxConfigSchema } = require("../../../src/config/schemas");
    const config = parseConfig(NaxConfigSchema, {
      execution: {
        mutationCheck: { enabled: true },
        // Ensure full-suite-gate runs for three-session strategy
        regressionGate: { mode: "per-story" },
      },
    });

    const story = { id: "s1", title: "Story One", description: "D", acceptanceCriteria: [] };
    const mockCtx: any = { config, storyId: "s1", runtime: { signal: new AbortController().signal } };

    // "three-session-tdd" is a three-session strategy → isThreeSession = true
    const testStrategy = "three-session-tdd";

    const baseInputs = {
      story,
      config,
      implementer: { op: ops.implementerOp, input: {} },
      fullSuiteGate: { op: ops.fullSuiteGateOp, input: {} },
      verifier: { op: ops.verifierOp, input: {} },
    };

    // With mutationCheck input → plan must include the phase
    const planWith = await buildPlanForStrategy(mockCtx, story, config, testStrategy, {
      ...baseInputs,
      mutationCheck: { op: ops.mutationCheckOp, input: {} },
    } as any);
    expect(planWith.phaseNames()).toContain("mutation-check");

    // Without mutationCheck input → plan must NOT include the phase
    const planWithout = await buildPlanForStrategy(
      mockCtx,
      story,
      config,
      testStrategy,
      baseInputs as any,
    );
    expect(planWithout.phaseNames()).not.toContain("mutation-check");
  });

  test("AC-35: mutation-check success (survivors present) does not prevent verifier from executing", () => {
    const { StoryOrchestratorBuilder } = require("../../../src/execution/story-orchestrator/builder");
    const { STRICT_VERDICT_PHASE_NAMES } = require("../../../src/execution/story-orchestrator/types");
    const ops = require("../../../src/operations");
    const { NaxConfigSchema } = require("../../../src/config/schemas");
    const config = parseConfig(NaxConfigSchema, {});

    const builder = new StoryOrchestratorBuilder();
    builder
      .addImplementer({ op: ops.implementerOp, input: {} })
      .addFullSuiteGate({ op: ops.fullSuiteGateOp, input: {} })
      .addMutationCheck({ op: ops.mutationCheckOp, input: {} })
      .addVerifier({ op: ops.verifierOp, input: {} });

    const plan = builder.build({ config, storyId: "test" } as any, { isThreeSession: true });
    const phases = plan.phaseNames();

    // Both phases present in plan
    expect(phases).toContain("mutation-check");
    expect(phases).toContain("verifier");

    // verifier comes after mutation-check in execution order
    const mcIdx = phases.indexOf("mutation-check");
    const vrIdx = phases.indexOf("verifier");
    expect(vrIdx).toBeGreaterThan(mcIdx);

    // mutation-check is advisory: not in strict-verdict set, so its success:true
    // result can never short-circuit downstream phases (including verifier)
    expect(STRICT_VERDICT_PHASE_NAMES.has("mutation-check")).toBe(false);
  });
});