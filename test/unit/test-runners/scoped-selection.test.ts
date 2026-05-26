import { describe, test, expect, afterEach } from "bun:test";
import { selectScopedTests, _scopedSelectionDeps } from "@/test-runners";

function makeFakeDeps(overrides: Partial<typeof _scopedSelectionDeps> = {}) {
  return {
    getChangedNonTestFiles: async () => ["src/a.ts"],
    mapSourceToTests: async () => [] as string[],
    importGrepFallback: async () => [] as string[],
    buildSmartTestCommand: (files: string[], base: string) => `${base} ${files.join(" ")}`,
    ...overrides,
  };
}

// Snapshot/restore so Object.assign mutations don't bleed across tests.
const originalDeps = { ..._scopedSelectionDeps };
afterEach(() => Object.assign(_scopedSelectionDeps, originalDeps));

describe("selectScopedTests", () => {
  const baseInput = {
    workdir: "/repo",
    storyId: "S-1",
    storyGitRef: "abc123",
    testCommand: "bun test",
    smartRunnerConfig: { enabled: true, fallback: "import-grep" as const, testFilePatterns: ["**/*.test.ts"] },
  };

  test("monorepo orchestrator command bypasses smart runner", async () => {
    const fakeDeps = makeFakeDeps({
      getChangedNonTestFiles: async () => {
        throw new Error("should not be called");
      },
    });
    Object.assign(_scopedSelectionDeps, fakeDeps);
    const result = await selectScopedTests({ ...baseInput, testCommand: "turbo run test" });
    expect(result.isMonorepoOrchestrator).toBe(true);
    expect(result.isFullSuite).toBe(true);
    expect(result.effectiveCommand).toBe("turbo run test");
  });

  test("Pass 1 match below threshold → scoped command", async () => {
    Object.assign(
      _scopedSelectionDeps,
      makeFakeDeps({
        mapSourceToTests: async () => ["test/a.test.ts", "test/b.test.ts"],
      }),
    );
    const result = await selectScopedTests({ ...baseInput, scopeTestThreshold: 10 });
    expect(result.isFullSuite).toBe(false);
    expect(result.effectiveCommand).toBe("bun test test/a.test.ts test/b.test.ts");
    expect(result.scopeTestFallback).toBeUndefined();
  });

  test("Pass 1 above threshold → fallback to full suite", async () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) => `test/t${i}.test.ts`);
    Object.assign(_scopedSelectionDeps, makeFakeDeps({ mapSourceToTests: async () => manyFiles }));
    const result = await selectScopedTests({
      ...baseInput,
      scopeTestThreshold: 10,
      fallbackFullSuiteCommand: "bun test --all",
    });
    expect(result.thresholdFallback).toBe(true);
    expect(result.scopeTestFallback).toBe(true);
    expect(result.effectiveCommand).toBe("bun test --all");
    expect(result.isFullSuite).toBe(true);
  });

  test("Pass 1 empty + Pass 2 match → import-grep result", async () => {
    Object.assign(
      _scopedSelectionDeps,
      makeFakeDeps({
        mapSourceToTests: async () => [],
        importGrepFallback: async () => ["test/x.test.ts"],
      }),
    );
    const result = await selectScopedTests(baseInput);
    expect(result.isFullSuite).toBe(false);
    expect(result.effectiveCommand).toBe("bun test test/x.test.ts");
  });

  test("Pass 1 + Pass 2 both empty → full-suite, no fallback flag", async () => {
    Object.assign(
      _scopedSelectionDeps,
      makeFakeDeps({
        mapSourceToTests: async () => [],
        importGrepFallback: async () => [],
      }),
    );
    const result = await selectScopedTests(baseInput);
    expect(result.isFullSuite).toBe(true);
    expect(result.scopeTestFallback).toBeUndefined();
    expect(result.thresholdFallback).toBe(false);
  });

  test("testScopedTemplate overrides buildSmartTestCommand", async () => {
    Object.assign(
      _scopedSelectionDeps,
      makeFakeDeps({
        mapSourceToTests: async () => ["test/a.test.ts"],
        buildSmartTestCommand: () => {
          throw new Error("should not be called");
        },
      }),
    );
    const result = await selectScopedTests({
      ...baseInput,
      testScopedTemplate: "pytest {{files}}",
    });
    expect(result.effectiveCommand).toBe("pytest 'test/a.test.ts'");
  });

  test("smart runner disabled → base command, no smart-runner call", async () => {
    Object.assign(
      _scopedSelectionDeps,
      makeFakeDeps({
        getChangedNonTestFiles: async () => {
          throw new Error("should not be called");
        },
      }),
    );
    const result = await selectScopedTests({
      ...baseInput,
      smartRunnerConfig: { enabled: false },
    });
    expect(result.isFullSuite).toBe(true);
    expect(result.effectiveCommand).toBe("bun test");
  });

  test("missing storyGitRef → base command", async () => {
    Object.assign(
      _scopedSelectionDeps,
      makeFakeDeps({
        getChangedNonTestFiles: async () => {
          throw new Error("should not be called");
        },
      }),
    );
    const result = await selectScopedTests({ ...baseInput, storyGitRef: undefined });
    expect(result.isFullSuite).toBe(true);
  });
});
