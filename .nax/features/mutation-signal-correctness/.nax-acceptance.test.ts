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
 */
function parseConfig(schema: any, overrides: any = {}): any {
  const defaults = schema.parse({});
  if (Object.keys(overrides).length === 0) return defaults;
  return mergeDeep(defaults, overrides);
}

/** Build a minimal CallContext with mutationCheck config + runtime overrides. */
function makeCtx(mutationCheckOverrides: Record<string, unknown> = {}, ctxOverrides: Record<string, unknown> = {}): any {
  const { NaxConfigSchema } = require("../../../src/config/schemas");
  const config = parseConfig(NaxConfigSchema, {
    execution: { mutationCheck: { enabled: true, ...mutationCheckOverrides } },
    quality: { commands: { test: "bun test" } },
  });
  const packageView = {
    packageDir: ".",
    repoRoot: "/tmp",
    hasOverride: false,
    config,
    select: (selector: any) => selector.select(config),
  };
  return {
    config,
    storyId: "test-story",
    packageView,
    runtime: { mutationSummaries: new Map() },
    ...ctxOverrides,
  };
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

/** TypeScript source with `n` distinct spaced-arithmetic candidate lines. */
function manyArithLines(prefix: string, n = 8): string {
  return Array.from({ length: n }, (_, i) => `const ${prefix}${i} = a${i} + b${i};`).join("\n");
}

// ─── US-001: Whitespace-guard the arithmetic mutation operators ─────────────

describe("US-001: Whitespace-guard the arithmetic mutation operators", () => {
  test("AC-1: import { NaxError } from \"@/errors\"; yields no ts:arith-flip mutant", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({
      source: 'import { NaxError } from "@/errors";',
      language: "typescript",
      file: "test.ts",
    });
    expect(result.filter((m: any) => m.operatorId === "ts:arith-flip")).toHaveLength(0);
  });

  test('AC-2: import type { Mutant } from "./types"; yields no ts:arith-flip mutant', () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({
      source: 'import type { Mutant } from "./types";',
      language: "typescript",
      file: "test.ts",
    });
    expect(result.filter((m: any) => m.operatorId === "ts:arith-flip")).toHaveLength(0);
  });

  test('AC-3: a URL string literal yields no ts:arith-flip mutant', () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({
      source: 'const url = "https://a.example/b/c";',
      language: "typescript",
      file: "test.ts",
    });
    expect(result.filter((m: any) => m.operatorId === "ts:arith-flip")).toHaveLength(0);
  });

  test("AC-4: spaced subtraction flips to spaced addition", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({ source: "const idx = line - 1;", language: "typescript", file: "test.ts" });
    const mutant = result.find((m: any) => m.operatorId === "ts:arith-flip");
    expect(mutant?.after).toBe("const idx = line + 1;");
  });

  test("AC-5: spaced addition flips to spaced subtraction", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({ source: "const total = a + b;", language: "typescript", file: "test.ts" });
    const mutant = result.find((m: any) => m.operatorId === "ts:arith-flip");
    expect(mutant?.after).toBe("const total = a - b;");
  });

  test("AC-6: spaced division flips to spaced multiplication", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({ source: "const half = n / 2;", language: "typescript", file: "test.ts" });
    const mutant = result.find((m: any) => m.operatorId === "ts:arith-flip");
    expect(mutant?.after).toBe("const half = n * 2;");
  });

  test("AC-7: spaced multiplication flips to spaced division", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({ source: "const twice = n * 2;", language: "typescript", file: "test.ts" });
    const mutant = result.find((m: any) => m.operatorId === "ts:arith-flip");
    expect(mutant?.after).toBe("const twice = n / 2;");
  });

  test("AC-8: Python spaced addition flips via py:arith-flip", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({ source: "y = a + b", language: "python", file: "test.py" });
    const mutant = result.find((m: any) => m.operatorId === "py:arith-flip");
    expect(mutant?.after).toBe("y = a - b");
  });

  test("AC-9: Python path string literal yields no py:arith-flip mutant", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({ source: 'path = "a/b/c"', language: "python", file: "test.py" });
    expect(result.filter((m: any) => m.operatorId === "py:arith-flip")).toHaveLength(0);
  });

  test("AC-10: Go spaced addition flips via go:arith-flip", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({ source: "sum := a + b", language: "go", file: "test.go" });
    const mutant = result.find((m: any) => m.operatorId === "go:arith-flip");
    expect(mutant?.after).toBe("sum := a - b");
  });

  test("AC-11: Rust spaced addition flips via rust:arith-flip", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const result = generateMutants({ source: "let sum = a + b;", language: "rust", file: "test.rs" });
    const mutant = result.find((m: any) => m.operatorId === "rust:arith-flip");
    expect(mutant?.after).toBe("let sum = a - b;");
  });

  test("AC-12: mutants past a five-line import block have line >= 6", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const source = [
      'import x from "a";',
      'import y from "b";',
      'import z from "c";',
      'import w from "d";',
      'import v from "e";',
      "const idx = line - 1;",
    ].join("\n");
    const result = generateMutants({ source, language: "typescript", file: "test.ts" });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((m: any) => m.line >= 6)).toBe(true);
  });

  test("AC-13: identical calls to generateMutants are deeply equal", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const input = { source: "const idx = line - 1;", language: "typescript", file: "test.ts" };
    const result1 = generateMutants(input);
    const result2 = generateMutants(input);
    expect(result1).toEqual(result2);
  });
});

// ─── US-002: Even-spread mutant selection across all changed files ─────────

describe("US-002: Even-spread mutant selection across all changed files", () => {
  test("AC-14: selectEvenlySpaced is importable and callable as a function", () => {
    const { selectEvenlySpaced } = require("../../../src/verification/mutation/select");
    expect(typeof selectEvenlySpaced).toBe("function");
  });

  test("AC-15: nine mutants with max 3 returns exactly three mutants", () => {
    const { selectEvenlySpaced } = require("../../../src/verification/mutation/select");
    expect(selectEvenlySpaced(new Array(9), 3).length).toBe(3);
  });

  test("AC-16: nine mutants with max 3 returns positions 0, 3, 6", () => {
    const { selectEvenlySpaced } = require("../../../src/verification/mutation/select");
    const mutants = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}` }));
    const result = selectEvenlySpaced(mutants, 3);
    expect(result).toEqual([mutants[0], mutants[3], mutants[6]]);
  });

  test("AC-17: ten mutants with max 3 returns positions 0, 3, 6", () => {
    const { selectEvenlySpaced } = require("../../../src/verification/mutation/select");
    const mutants = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}` }));
    const result = selectEvenlySpaced(mutants, 3);
    expect(result).toEqual([mutants[0], mutants[3], mutants[6]]);
  });

  test("AC-18: two mutants with max 5 returns both in input order", () => {
    const { selectEvenlySpaced } = require("../../../src/verification/mutation/select");
    const a = { id: "a" };
    const b = { id: "b" };
    const result = selectEvenlySpaced([a, b], 5);
    expect(result).toEqual([a, b]);
  });

  test("AC-19: an empty list with max 3 returns an empty array", () => {
    const { selectEvenlySpaced } = require("../../../src/verification/mutation/select");
    expect(selectEvenlySpaced([], 3)).toEqual([]);
  });

  test("AC-20: nine mutants with max 0 returns an empty array", () => {
    const { selectEvenlySpaced } = require("../../../src/verification/mutation/select");
    expect(selectEvenlySpaced(new Array(9), 0)).toEqual([]);
  });

  test("AC-21: nine mutants with max -1 returns an empty array", () => {
    const { selectEvenlySpaced } = require("../../../src/verification/mutation/select");
    expect(selectEvenlySpaced(new Array(9), -1)).toEqual([]);
  });

  test("AC-22: repeated calls with the same input and max are deeply equal", () => {
    const { selectEvenlySpaced } = require("../../../src/verification/mutation/select");
    const mutants = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}` }));
    const result1 = selectEvenlySpaced(mutants, 3);
    const result2 = selectEvenlySpaced(mutants, 3);
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });

  test("AC-23: generateMutants with no max returns every candidate, not capped", () => {
    const { generateMutants } = require("../../../src/verification/mutation");
    const source = manyArithLines("x", 10);
    const result = generateMutants({ source, language: "typescript", file: "many.ts" });
    expect(result.length).toBe(10);
  });

  describe("mutationCheckOp — selection seam", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "nax-mutation-select-ac-"));
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });

    test("AC-24: maxMutants=2 with one file yielding 6+ candidates invokes regression exactly twice", async () => {
      const { mutationCheckOp } = require("../../../src/operations");
      const ctx = makeCtx({ maxMutants: 2 });
      const sourceFile = join(tempDir, "many-arith.ts");
      await Bun.write(sourceFile, manyArithLines("v", 8));

      let regressionCallCount = 0;
      const mockDeps = {
        detectLanguage: async () => "typescript",
        getChangedNonTestFiles: async () => [sourceFile],
        selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
        regression: async () => {
          regressionCallCount++;
          return { status: "TEST_FAILURE", passCount: 0, failCount: 1 };
        },
      };

      await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
      expect(regressionCallCount).toBe(2);
    });

    test("AC-25: maxMutants=2 with two files each yielding 6+ candidates produces survivors from two distinct files", async () => {
      const { mutationCheckOp } = require("../../../src/operations");
      const ctx = makeCtx({ maxMutants: 2 });
      const fileA = join(tempDir, "a.ts");
      const fileB = join(tempDir, "b.ts");
      await Bun.write(fileA, manyArithLines("a", 8));
      await Bun.write(fileB, manyArithLines("b", 8));

      const mockDeps = {
        detectLanguage: async () => "typescript",
        getChangedNonTestFiles: async () => [fileA, fileB],
        selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
        regression: async () => ({ status: "SUCCESS" }),
      };

      const result = await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
      expect(result.survivors.length).toBe(2);
      expect(result.survivors[0].file).not.toBe(result.survivors[1].file);
    });

    test("AC-26: a changed file yielding no candidate mutants never invokes regression", async () => {
      const { mutationCheckOp } = require("../../../src/operations");
      const ctx = makeCtx({ maxMutants: 2 });
      const sourceFile = join(tempDir, "no-candidates.ts");
      await Bun.write(sourceFile, 'const label = "hello world";');

      let regressionCallCount = 0;
      const mockDeps = {
        detectLanguage: async () => "typescript",
        getChangedNonTestFiles: async () => [sourceFile],
        selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
        regression: async () => {
          regressionCallCount++;
          return { status: "SUCCESS" };
        },
      };

      await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
      expect(regressionCallCount).toBe(0);
    });

    test("AC-27: no candidates after selection returns success:true, empty survivors, and all-zero outcomes", async () => {
      const { mutationCheckOp } = require("../../../src/operations");
      const ctx = makeCtx({ maxMutants: 2 });
      const sourceFile = join(tempDir, "empty.ts");
      await Bun.write(sourceFile, "");

      const mockDeps = {
        detectLanguage: async () => "typescript",
        getChangedNonTestFiles: async () => [sourceFile],
        selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
        regression: async () => ({ status: "SUCCESS" }),
      };

      const result = await mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
      expect(result.success).toBe(true);
      expect(result.survivors).toEqual([]);
      expect(result.outcomes).toEqual({ killed: 0, survived: 0, errored: 0 });
    });
  });
});

// ─── US-003: Classify mutants that never ran tests as errored ──────────────

describe("US-003: Classify mutants that never ran tests as errored", () => {
  test("AC-28: TEST_FAILURE with passCount 0 and failCount 0 returns errored", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "TEST_FAILURE", passCount: 0, failCount: 0 })).toBe("errored");
  });

  test("AC-29: TEST_FAILURE with no counts at all returns errored", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "TEST_FAILURE" })).toBe("errored");
  });

  test("AC-30: TEST_FAILURE with passCount 0 and failCount 1 returns killed", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "TEST_FAILURE", passCount: 0, failCount: 1 })).toBe("killed");
  });

  test("AC-31: TEST_FAILURE with passCount 5 and failCount 2 returns killed", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "TEST_FAILURE", passCount: 5, failCount: 2 })).toBe("killed");
  });

  test("AC-32: SUCCESS returns survived", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "SUCCESS" })).toBe("survived");
  });

  test("AC-33: TIMEOUT returns errored", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "TIMEOUT" })).toBe("errored");
  });

  test("AC-34: ENVIRONMENTAL_FAILURE returns errored", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "ENVIRONMENTAL_FAILURE" })).toBe("errored");
  });

  test("AC-35: ASSET_CHECK_FAILED returns errored", () => {
    const { classifyMutant } = require("../../../src/verification/mutation");
    expect(classifyMutant({ status: "ASSET_CHECK_FAILED" })).toBe("errored");
  });

  describe("mutationCheckOp — outcome aggregation seam", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "nax-mutation-outcomes-ac-"));
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });

    async function runSingleCandidate(regressionResult: Record<string, unknown>): Promise<any> {
      const { mutationCheckOp } = require("../../../src/operations");
      const ctx = makeCtx({ maxMutants: 5 });
      const sourceFile = join(tempDir, "single.ts");
      await Bun.write(sourceFile, "const idx = line - 1;");

      const mockDeps = {
        detectLanguage: async () => "typescript",
        getChangedNonTestFiles: async () => [sourceFile],
        selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
        regression: async () => regressionResult,
      };

      return mutationCheckOp.execute(makeInput({ workdir: tempDir }), ctx, mockDeps);
    }

    test("AC-36: outcomes.errored is 1 when TEST_FAILURE carries no evidence tests ran", async () => {
      const result = await runSingleCandidate({ status: "TEST_FAILURE", passCount: 0, failCount: 0 });
      expect(result.outcomes.errored).toBe(1);
    });

    test("AC-37: outcomes.killed is 0 when TEST_FAILURE carries no evidence tests ran", async () => {
      const result = await runSingleCandidate({ status: "TEST_FAILURE", passCount: 0, failCount: 0 });
      expect(result.outcomes.killed).toBe(0);
    });

    test("AC-38: outcomes.killed is 1 when TEST_FAILURE carries failCount 1", async () => {
      const result = await runSingleCandidate({ status: "TEST_FAILURE", passCount: 0, failCount: 1 });
      expect(result.outcomes.killed).toBe(1);
    });

    test("AC-39: outcomes.survived is 1 when regression returns SUCCESS", async () => {
      const result = await runSingleCandidate({ status: "SUCCESS" });
      expect(result.outcomes.survived).toBe(1);
    });

    test("AC-40: survivors has length 0 when TEST_FAILURE carries no evidence tests ran", async () => {
      const result = await runSingleCandidate({ status: "TEST_FAILURE", passCount: 0, failCount: 0 });
      expect(result.survivors.length).toBe(0);
    });
  });
});

// ─── US-004: Surface surviving mutants at run end ────────────────────────────

describe("US-004: Surface surviving mutants at run end", () => {
  test("AC-41: formatMutationSummary is importable and callable as a function", () => {
    const { formatMutationSummary } = require("../../../src/log-format/mutation-summary");
    expect(typeof formatMutationSummary).toBe("function");
  });

  test("AC-42: output contains the surviving mutant's file path", () => {
    const { formatMutationSummary } = require("../../../src/log-format/mutation-summary");
    const output = formatMutationSummary([
      {
        storyId: "US-001",
        survivors: [{ id: "surv-1", filePath: "/src/foo.ts", line: 42, operatorId: "arith" }],
        killed: 0,
        errored: 0,
      },
    ]);
    expect(output).toContain("/src/foo.ts");
  });

  test("AC-43: output contains the surviving mutant's line number", () => {
    const { formatMutationSummary } = require("../../../src/log-format/mutation-summary");
    const output = formatMutationSummary([
      {
        storyId: "US-001",
        survivors: [{ id: "surv-1", filePath: "/src/foo.ts", line: 42, operatorId: "arith" }],
        killed: 0,
        errored: 0,
      },
    ]);
    expect(output).toContain("42");
  });

  test("AC-44: output contains the surviving mutant's operatorId", () => {
    const { formatMutationSummary } = require("../../../src/log-format/mutation-summary");
    const output = formatMutationSummary([
      {
        storyId: "US-001",
        survivors: [{ id: "surv-1", filePath: "/src/foo.ts", line: 42, operatorId: "arith" }],
        killed: 0,
        errored: 0,
      },
    ]);
    expect(output).toContain("arith");
  });

  test("AC-45: output contains the story's id", () => {
    const { formatMutationSummary } = require("../../../src/log-format/mutation-summary");
    const output = formatMutationSummary([
      {
        storyId: "US-001",
        survivors: [{ id: "surv-1", filePath: "/src/foo.ts", line: 42, operatorId: "arith" }],
        killed: 0,
        errored: 0,
      },
    ]);
    expect(output).toContain("US-001");
  });

  test("AC-46: an empty collection of summaries returns an empty string", () => {
    const { formatMutationSummary } = require("../../../src/log-format/mutation-summary");
    expect(formatMutationSummary([])).toBe("");
  });

  test("AC-47: summaries with only killed/errored counts and no survivors return an empty string", () => {
    const { formatMutationSummary } = require("../../../src/log-format/mutation-summary");
    const output = formatMutationSummary([{ storyId: "US-001", survivors: [], killed: 5, errored: 1 }]);
    expect(output).toBe("");
  });

  test("AC-48: output contains the second story's surviving mutant file path", () => {
    const { formatMutationSummary } = require("../../../src/log-format/mutation-summary");
    const output = formatMutationSummary([
      { storyId: "US-001", survivors: [{ id: "s1", filePath: "/src/a.ts", line: 10, operatorId: "op1" }], killed: 0, errored: 0 },
      { storyId: "US-002", survivors: [{ id: "s2", filePath: "/src/b.ts", line: 20, operatorId: "op2" }], killed: 0, errored: 0 },
    ]);
    expect(output).toContain("/src/b.ts");
  });

  describe("mutationCheckOp — runtime recording seam", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "nax-mutation-runtime-ac-"));
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });

    test("AC-49: runtime.mutationSummaries holds a US-007 entry with one survivor", async () => {
      const { mutationCheckOp } = require("../../../src/operations");
      const runtime = { mutationSummaries: new Map() };
      const ctx = makeCtx({ maxMutants: 5 }, { storyId: "US-007", runtime });
      const sourceFile = join(tempDir, "survivor.ts");
      await Bun.write(sourceFile, "const idx = line - 1;");

      const mockDeps = {
        detectLanguage: async () => "typescript",
        getChangedNonTestFiles: async () => [sourceFile],
        selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
        regression: async () => ({ status: "SUCCESS" }),
      };

      await mutationCheckOp.execute(makeInput({ workdir: tempDir, storyId: "US-007" }), ctx, mockDeps);

      const summary = runtime.mutationSummaries.get("US-007");
      expect(summary).toBeDefined();
      expect(summary.survivors.length).toBe(1);
    });

    test("AC-50: runtime.mutationSummaries stays empty when the call context has no storyId", async () => {
      const { mutationCheckOp } = require("../../../src/operations");
      const runtime = { mutationSummaries: new Map() };
      const ctx = makeCtx({ maxMutants: 5 }, { storyId: undefined, runtime });
      const sourceFile = join(tempDir, "no-story.ts");
      await Bun.write(sourceFile, "const idx = line - 1;");

      const mockDeps = {
        detectLanguage: async () => "typescript",
        getChangedNonTestFiles: async () => [sourceFile],
        selectScopedTests: async () => ({ effectiveCommand: "bun test" }),
        regression: async () => ({ status: "SUCCESS" }),
      };

      await mutationCheckOp.execute(makeInput({ workdir: tempDir, storyId: undefined }), ctx, mockDeps);

      expect(runtime.mutationSummaries.size).toBe(0);
    });
  });

  describe("runCompletionPhase — headless survivor reporting", () => {
    let origDeps: any;
    let origLog: typeof console.log;

    function makeCompletionOpts(overrides: Record<string, unknown> = {}): any {
      const { makeNaxConfig, makeStory } = require("../../../test/helpers");
      const config = makeNaxConfig({
        acceptance: { enabled: false },
        execution: { regressionGate: { mode: "disabled" } },
      });
      const prd = {
        project: "test-project",
        feature: "mutation-signal-correctness",
        branchName: "test-branch",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [
          makeStory({
            id: "US-001",
            title: "Story One",
            description: "D",
            acceptanceCriteria: ["AC-1"],
            status: "passed",
            passes: true,
            attempts: 1,
          }),
        ],
      };
      return {
        config,
        hooks: { hooks: {}, _skipGlobal: false },
        feature: "mutation-signal-correctness",
        workdir: "/tmp/nax-mutation-completion-ac",
        statusFile: "/tmp/nax-mutation-completion-ac/status.json",
        runId: "run-mutation-ac",
        startedAt: new Date().toISOString(),
        startTime: Date.now() - 1000,
        headless: true,
        formatterMode: "normal",
        prd,
        allStoryMetrics: [],
        totalCost: 0,
        storiesCompleted: 1,
        iterations: 1,
        statusWriter: {
          getPostRunStatus: () => null,
          setPostRunPhase: () => {},
          setRunStatus: () => {},
          writeFeatureStatus: async () => {},
        },
        pluginRegistry: { getAll: () => [], get: () => undefined },
        prdPath: "/tmp/nax-mutation-completion-ac/prd.json",
        runtime: {
          mutationSummaries: new Map(),
          reviewAuditor: { getAdvisoryFindings: () => [] },
          close: async () => {},
        },
        ...overrides,
      };
    }

    beforeEach(() => {
      const { _runnerCompletionDeps } = require("../../../src/execution");
      origDeps = { ..._runnerCompletionDeps };
      _runnerCompletionDeps.handleRunCompletion = async () => ({
        durationMs: 10,
        runCompletedAt: new Date().toISOString(),
        reportedTotal: 0,
        finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
        pluginGateFailed: false,
      });
      origLog = console.log;
    });

    afterEach(() => {
      const { _runnerCompletionDeps } = require("../../../src/execution");
      Object.assign(_runnerCompletionDeps, origDeps);
      console.log = origLog;
    });

    test("AC-51: headless normal mode writes the survivor's file path to stdout", async () => {
      const { runCompletionPhase } = require("../../../src/execution");
      const logs: string[] = [];
      console.log = ((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }) as typeof console.log;

      const runtime = {
        mutationSummaries: new Map([
          [
            "US-001",
            {
              storyId: "US-001",
              survivors: [{ id: "s1", filePath: "/src/foo.ts", line: 1, operatorId: "ts:arith-flip" }],
              killed: 0,
              errored: 0,
            },
          ],
        ]),
        reviewAuditor: { getAdvisoryFindings: () => [] },
        close: async () => {},
      };

      await runCompletionPhase(makeCompletionOpts({ headless: true, formatterMode: "normal", runtime }));

      expect(logs.some((l) => l.includes("/src/foo.ts"))).toBe(true);
    });

    test("AC-52: headless json mode writes nothing containing the survivor's file path", async () => {
      const { runCompletionPhase } = require("../../../src/execution");
      const logs: string[] = [];
      console.log = ((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }) as typeof console.log;

      const runtime = {
        mutationSummaries: new Map([
          [
            "US-001",
            {
              storyId: "US-001",
              survivors: [{ id: "s1", filePath: "/src/foo.ts", line: 1, operatorId: "ts:arith-flip" }],
              killed: 0,
              errored: 0,
            },
          ],
        ]),
        reviewAuditor: { getAdvisoryFindings: () => [] },
        close: async () => {},
      };

      await runCompletionPhase(makeCompletionOpts({ headless: true, formatterMode: "json", runtime }));

      expect(logs.some((l) => l.includes("/src/foo.ts"))).toBe(false);
    });

    test("AC-53: headless normal mode with no survivors writes nothing containing 'surviving mutant'", async () => {
      const { runCompletionPhase } = require("../../../src/execution");
      const logs: string[] = [];
      console.log = ((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }) as typeof console.log;

      const runtime = {
        mutationSummaries: new Map(),
        reviewAuditor: { getAdvisoryFindings: () => [] },
        close: async () => {},
      };

      await runCompletionPhase(makeCompletionOpts({ headless: true, formatterMode: "normal", runtime }));

      expect(logs.some((l) => l.includes("surviving mutant"))).toBe(false);
    });

    test("AC-54: emits a warn log record whose data carries survivorCount 1", async () => {
      const { runCompletionPhase } = require("../../../src/execution");
      const { withWarnSpy } = require("../../../test/helpers");

      const runtime = {
        mutationSummaries: new Map([
          [
            "US-001",
            {
              storyId: "US-001",
              survivors: [{ id: "s1", filePath: "/src/foo.ts", line: 1, operatorId: "ts:arith-flip" }],
              killed: 0,
              errored: 0,
            },
          ],
        ]),
        reviewAuditor: { getAdvisoryFindings: () => [] },
        close: async () => {},
      };

      await withWarnSpy(async (warnSpy: any) => {
        await runCompletionPhase(makeCompletionOpts({ runtime }));

        const call = warnSpy.mock.calls.find((c: any[]) => {
          const data = c[2];
          return data && typeof data === "object" && data.survivorCount === 1;
        });
        expect(call).toBeDefined();
      });
    });
  });
});