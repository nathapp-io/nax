import { describe, expect, test, afterEach } from "bun:test";
import { verifyScopedOp, _verifyScopedDeps } from "@/operations";
import type { VerifyScopedDeps } from "@/operations";
import type { Finding } from "@/findings";

function ctxWithQuality(quality?: Record<string, unknown>, opts: { hasOverride?: boolean; repoRoot?: string } = {}) {
  const config = { quality, execution: {} } as any;
  return {
    runtime: {},
    storyId: "US-003",
    packageView: {
      packageDir: "packages/agent",
      repoRoot: opts.repoRoot ?? "/repo",
      hasOverride: opts.hasOverride ?? false,
      config,
      select: (s: any) => s.select(config),
    },
  } as any;
}

const mockFinding: Finding = {
  source: "test-runner",
  severity: "error",
  category: "failed-test",
  message: "Expected true to be false",
  file: "test/unit/foo.test.ts",
  rule: "my test",
};

// Snapshot/restore so mutations don't bleed across tests.
const originalVerifyScopedDeps = { ..._verifyScopedDeps };
afterEach(() => Object.assign(_verifyScopedDeps, originalVerifyScopedDeps));

function fakeDeps(overrides: Partial<VerifyScopedDeps> = {}): VerifyScopedDeps {
  return {
    selectScopedTests: async () => ({
      effectiveCommand: "bun test",
      isFullSuite: true,
      thresholdFallback: false,
      isMonorepoOrchestrator: false,
    }),
    regression: async () => ({
      status: "SUCCESS" as const,
      success: true,
      countsTowardEscalation: true,
      output: "1 pass\n0 fail",
    }),
    parseTestOutput: () => ({ passed: 1, failed: 0, failures: [] }),
    testSummaryToFindings: () => [],
    ...overrides,
  };
}

describe("verifyScopedOp — AC2: DeterministicOperation shape", () => {
  test("kind is deterministic", () => {
    expect(verifyScopedOp.kind).toBe("deterministic");
  });

  test("name is verify-scoped", () => {
    expect(verifyScopedOp.name).toBe("verify-scoped");
  });

  test("has execute function, not build/parse", () => {
    expect(typeof verifyScopedOp.execute).toBe("function");
    expect((verifyScopedOp as any).build).toBeUndefined();
    expect((verifyScopedOp as any).parse).toBeUndefined();
  });
});

describe("verifyScopedOp — AC5: execute returns success=true when test command exits 0", () => {
  test("AC5: returns success=true and findings=[] when test command exits 0", async () => {
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story" },
      ctxWithQuality({ commands: { test: "bun test" } }),
      fakeDeps(),
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.status).toBe("passed");
    expect(out.passCount).toBe(1);
    expect(out.isFullSuite).toBe(true);
  });

  test("AC5: returns success=false and non-empty findings when test command exits non-zero", async () => {
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story" },
      ctxWithQuality({ commands: { test: "bun test" } }),
      fakeDeps({
        regression: async () => ({
          status: "TEST_FAILURE" as const,
          success: false,
          countsTowardEscalation: true,
          output: "1 test failed",
        }),
        parseTestOutput: () => ({
          passed: 0,
          failed: 1,
          failures: [{ file: "test/unit/foo.test.ts", testName: "my test", error: "Expected true to be false", stackTrace: [] }],
        }),
        testSummaryToFindings: () => [mockFinding],
      }),
    );
    expect(out.success).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.status).toBe("failed");
  });

  test("AC5: every finding has source='test-runner' when test command exits non-zero", async () => {
    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003", regressionMode: "per-story" },
      ctxWithQuality({ commands: { test: "bun test" } }),
      fakeDeps({
        regression: async () => ({
          status: "TEST_FAILURE" as const,
          success: false,
          countsTowardEscalation: true,
          output: "1 test failed",
        }),
        parseTestOutput: () => ({
          passed: 0,
          failed: 1,
          failures: [{ file: "test/unit/foo.test.ts", testName: "my test", error: "Expected", stackTrace: [] }],
        }),
        testSummaryToFindings: () => [mockFinding],
      }),
    );
    expect(out.findings.every((f: Finding) => f.source === "test-runner")).toBe(true);
  });
});

describe("verifyScopedOp — AC6: no-command early return", () => {
  test("AC6: returns success=true, findings=[], durationMs=0 when test command is undefined", async () => {
    let selectionCalled = false;
    const deps = fakeDeps({
      selectScopedTests: async () => {
        selectionCalled = true;
        return { effectiveCommand: "bun test", isFullSuite: true, thresholdFallback: false, isMonorepoOrchestrator: false };
      },
    });

    const out = await verifyScopedOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithQuality({ commands: {} }),
      deps,
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.durationMs).toBe(0);
    expect(selectionCalled).toBe(false);
  });
});

describe("verifyScopedOp — ported ScopedStrategy behavior", () => {
  test("deferred mode + no mapped tests + not monorepo → skipped", async () => {
    const deps = fakeDeps();
    const ctx = ctxWithQuality({ commands: { test: "bun test" } });
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "deferred" },
      ctx,
      deps,
    );
    expect(result.status).toBe("skipped");
    expect(result.success).toBe(true);
  });

  test("per-story mode + no mapped tests → runs full suite (not skipped)", async () => {
    const deps = fakeDeps();
    const ctx = ctxWithQuality({ commands: { test: "bun test" } });
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "per-story" },
      ctx,
      deps,
    );
    expect(result.status).toBe("passed");
    expect(result.isFullSuite).toBe(true);
  });

  test("monorepo orchestrator → runs even in deferred mode", async () => {
    const deps = fakeDeps({
      selectScopedTests: async () => ({
        effectiveCommand: "turbo run test",
        isFullSuite: true,
        thresholdFallback: false,
        isMonorepoOrchestrator: true,
      }),
    });
    const ctx = ctxWithQuality({ commands: { test: "turbo run test" } });
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "deferred" },
      ctx,
      deps,
    );
    expect(result.status).toBe("passed");
  });

  test("threshold fallback → scopeTestFallback=true in envelope", async () => {
    const deps = fakeDeps({
      selectScopedTests: async () => ({
        effectiveCommand: "bun test",
        isFullSuite: true,
        thresholdFallback: true,
        scopeTestFallback: true,
        isMonorepoOrchestrator: false,
      }),
    });
    const ctx = ctxWithQuality({ commands: { test: "bun test" } });
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "deferred" },
      ctx,
      deps,
    );
    expect(result.status).toBe("passed");
    expect(result.scopeTestFallback).toBe(true);
  });

  test("scoped match → isFullSuite=false", async () => {
    const deps = fakeDeps({
      selectScopedTests: async () => ({
        effectiveCommand: "bun test test/a.test.ts",
        isFullSuite: false,
        thresholdFallback: false,
        isMonorepoOrchestrator: false,
      }),
    });
    const ctx = ctxWithQuality({ commands: { test: "bun test" } });
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", storyGitRef: "abc", regressionMode: "per-story" },
      ctx,
      deps,
    );
    expect(result.isFullSuite).toBe(false);
  });

  test("test failure → status=failed with findings", async () => {
    const deps = fakeDeps({
      regression: async () => ({
        status: "TEST_FAILURE" as const,
        success: false,
        countsTowardEscalation: true,
        output: "1 pass\n2 fail",
      }),
      parseTestOutput: () => ({
        passed: 1,
        failed: 2,
        failures: [{ testName: "t1", file: "a.test.ts", error: "boom", stackTrace: [] }],
      }),
      testSummaryToFindings: () => [{ kind: "test", id: "f1" } as any],
    });
    const ctx = ctxWithQuality({ commands: { test: "bun test" } });
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "per-story" },
      ctx,
      deps,
    );
    expect(result.status).toBe("failed");
    expect(result.success).toBe(false);
    expect(result.findings.length).toBe(1);
  });

  test("workdir routing — uses repoRoot when no per-package override", async () => {
    let seenWorkdir = "";
    const deps = fakeDeps({
      regression: async (opts) => { seenWorkdir = opts.workdir; return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" }; },
    });
    await verifyScopedOp.execute(
      { workdir: "/repo/packages/app", storyId: "S-1", regressionMode: "per-story" },
      ctxWithQuality({ commands: { test: "bun run test" } }, { hasOverride: false, repoRoot: "/repo" }),
      deps,
    );
    expect(seenWorkdir).toBe("/repo");
  });

  test("workdir routing — uses input.workdir (packageDir) when per-package override exists", async () => {
    let seenWorkdir = "";
    const deps = fakeDeps({
      regression: async (opts) => { seenWorkdir = opts.workdir; return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "" }; },
    });
    await verifyScopedOp.execute(
      { workdir: "/repo/packages/lib", storyId: "S-1", regressionMode: "per-story" },
      ctxWithQuality({ commands: { test: "bun test" } }, { hasOverride: true, repoRoot: "/repo" }),
      deps,
    );
    expect(seenWorkdir).toBe("/repo/packages/lib");
  });

  test("forwards repoRoot/packagePrefix/resolvedTestPatterns to selectScopedTests (Pass 0 anchors)", async () => {
    let seen: Record<string, unknown> | undefined;
    const resolvedTestPatterns = { globs: ["tests/**/*.py"], pathspec: [], regex: [/test_.*\.py$/], testDirs: ["tests"] } as any;
    const deps = fakeDeps({
      selectScopedTests: async (input) => {
        seen = input as unknown as Record<string, unknown>;
        return { effectiveCommand: "uv run pytest", isFullSuite: true, thresholdFallback: false, isMonorepoOrchestrator: false };
      },
    });
    await verifyScopedOp.execute(
      {
        workdir: "/repo/packages/core",
        storyId: "S-1",
        storyGitRef: "abc",
        regressionMode: "per-story",
        repoRoot: "/repo",
        packagePrefix: "packages/core",
        resolvedTestPatterns,
      },
      ctxWithQuality({ commands: { test: "uv run pytest" } }, { hasOverride: true, repoRoot: "/repo" }),
      deps,
    );
    expect(seen?.repoRoot).toBe("/repo");
    expect(seen?.packagePrefix).toBe("packages/core");
    expect(seen?.resolvedTestPatterns).toBe(resolvedTestPatterns);
  });

  test("timeout → status=timeout, success=false", async () => {
    const deps = fakeDeps({
      regression: async () => ({
        status: "TIMEOUT" as const,
        success: false,
        countsTowardEscalation: false,
        output: "",
      }),
      parseTestOutput: () => ({ passed: 0, failed: 0, failures: [] }),
    });
    const ctx = ctxWithQuality({ commands: { test: "bun test" } });
    const result = await verifyScopedOp.execute(
      { workdir: "/r", storyId: "S-1", regressionMode: "per-story" },
      ctx,
      deps,
    );
    expect(result.status).toBe("timeout");
    expect(result.success).toBe(false);
  });
});
