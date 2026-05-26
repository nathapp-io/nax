import { afterEach, describe, expect, test } from "bun:test";
import { fullSuiteGateOp, verifyScopedOp } from "@/operations";
import { _regressionStrategyDeps, RegressionStrategy } from "@/verification/strategies/regression";
import { _scopedDeps, ScopedStrategy } from "@/verification/strategies/scoped";

/**
 * Parity gate for issue #1116.
 *
 * THROWAWAY MIGRATION SAFETY NET — this file is DELETED in Phase 5 along with
 * the strategy classes it imports. Do not extend it for long-term coverage;
 * port that coverage into test/unit/operations/*.test.ts instead (Phase 2.7,
 * Phase 3.5). The point of this file is to prove envelope equivalence DURING
 * the migration, then disappear.
 */

// Snapshot/restore module-level deps to prevent bleed across tests.
const origScopedDeps = { ..._scopedDeps };
const origRegressionDeps = { ..._regressionStrategyDeps };

afterEach(() => {
  Object.assign(_scopedDeps, origScopedDeps);
  Object.assign(_regressionStrategyDeps, origRegressionDeps);
});

// ─── Fake regression runner — returns SUCCESS, 5 passes ───────────────────
function fakeRegressionSuccess() {
  return async () => ({
    status: "SUCCESS" as const,
    success: true,
    countsTowardEscalation: true,
    output: "5 pass\n0 fail",
  });
}

describe("scoped: strategy ↔ op parity", () => {
  test("PASS case — same passCount, isFullSuite, scopeTestFallback", async () => {
    // Both paths: no mapped tests + per-story mode → falls back to full suite → 5 passes.
    _scopedDeps.getChangedNonTestFiles = async () => [];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];
    _scopedDeps.regression = fakeRegressionSuccess() as any;

    const stratResult = await new ScopedStrategy().execute({
      workdir: "/repo",
      storyId: "S-1",
      testCommand: "bun test",
      timeoutSeconds: 60,
      regressionMode: "per-story",
      storyGitRef: "abc123",
      config: { quality: { commands: { test: "bun test" } } } as any,
    });

    const opDeps = {
      selectScopedTests: async () => ({
        effectiveCommand: "bun test",
        isFullSuite: true,
        thresholdFallback: false,
        isMonorepoOrchestrator: false,
      }),
      regression: fakeRegressionSuccess(),
      parseTestOutput: () => ({ passed: 5, failed: 0, failures: [] }),
      testSummaryToFindings: () => [],
    };

    const opResult = await verifyScopedOp.execute(
      { workdir: "/repo", storyId: "S-1", storyGitRef: "abc123", regressionMode: "per-story" },
      { config: { quality: { commands: { test: "bun test" } } } } as any,
      opDeps as any,
    );

    // Envelope parity — apply the mapping table from docs/architecture/subsystems.md
    expect(stratResult.status).toBe("PASS");
    expect(opResult.status).toBe("passed");
    expect(stratResult.success).toBe(opResult.success);
    expect(opResult.isFullSuite).toBe(true);
    expect(opResult.scopeTestFallback).toBe(stratResult.scopeTestFallback);
  });

  test("SKIPPED case — deferred + no mapped tests + not monorepo orchestrator", async () => {
    _scopedDeps.getChangedNonTestFiles = async () => [];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];

    const stratResult = await new ScopedStrategy().execute({
      workdir: "/repo",
      storyId: "S-1",
      testCommand: "bun test",
      timeoutSeconds: 60,
      regressionMode: "deferred",
      storyGitRef: "abc123",
      config: { quality: { commands: { test: "bun test" } } } as any,
    });

    const opDeps = {
      selectScopedTests: async () => ({
        effectiveCommand: "bun test",
        isFullSuite: true,
        thresholdFallback: false,
        isMonorepoOrchestrator: false,
      }),
      regression: fakeRegressionSuccess(),
      parseTestOutput: () => ({ passed: 0, failed: 0, failures: [] }),
      testSummaryToFindings: () => [],
    };

    const opResult = await verifyScopedOp.execute(
      { workdir: "/repo", storyId: "S-1", storyGitRef: "abc123", regressionMode: "deferred" },
      { config: { quality: { commands: { test: "bun test" } } } } as any,
      opDeps as any,
    );

    // Both should be skipped
    expect(stratResult.status).toBe("SKIPPED");
    expect(opResult.status).toBe("skipped");
    expect(stratResult.success).toBe(true);
    expect(opResult.success).toBe(true);
  });

  test("THRESHOLD fallback — scope > threshold → full suite with scopeTestFallback=true", async () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) => `test/t${i}.test.ts`);
    _scopedDeps.getChangedNonTestFiles = async () => ["src/a.ts"];
    _scopedDeps.mapSourceToTests = async () => manyFiles;
    _scopedDeps.regression = fakeRegressionSuccess() as any;

    const stratResult = await new ScopedStrategy().execute({
      workdir: "/repo",
      storyId: "S-1",
      testCommand: "bun test",
      timeoutSeconds: 60,
      regressionMode: "per-story",
      storyGitRef: "abc123",
      config: {
        quality: { commands: { test: "bun test" }, scopeTestThreshold: 10 },
        execution: { smartTestRunner: true },
      } as any,
    });

    const opDeps = {
      selectScopedTests: async () => ({
        effectiveCommand: "bun test",
        isFullSuite: true,
        thresholdFallback: true,
        scopeTestFallback: true,
        isMonorepoOrchestrator: false,
      }),
      regression: fakeRegressionSuccess(),
      parseTestOutput: () => ({ passed: 5, failed: 0, failures: [] }),
      testSummaryToFindings: () => [],
    };

    const opResult = await verifyScopedOp.execute(
      { workdir: "/repo", storyId: "S-1", storyGitRef: "abc123", regressionMode: "per-story" },
      { config: { quality: { commands: { test: "bun test" } } } } as any,
      opDeps as any,
    );

    // Both should have scopeTestFallback=true and succeed
    expect(stratResult.scopeTestFallback).toBe(true);
    expect(opResult.scopeTestFallback).toBe(true);
    expect(stratResult.status === "PASS").toBe(opResult.status === "passed");
    expect(stratResult.success).toBe(opResult.success);
  });

  test("MONOREPO orchestrator — turbo command bypasses smart runner", async () => {
    // turbo command: smart runner should NOT be called (strategy bails early)
    _scopedDeps.regression = fakeRegressionSuccess() as any;

    const opDeps = {
      selectScopedTests: async () => ({
        effectiveCommand: "turbo run test",
        isFullSuite: true,
        thresholdFallback: false,
        isMonorepoOrchestrator: true,
      }),
      regression: fakeRegressionSuccess(),
      parseTestOutput: () => ({ passed: 5, failed: 0, failures: [] }),
      testSummaryToFindings: () => [],
    };

    const opResult = await verifyScopedOp.execute(
      { workdir: "/repo", storyId: "S-1", regressionMode: "per-story" },
      { config: { quality: { commands: { test: "turbo run test" } } } } as any,
      opDeps as any,
    );

    // Op runs (monorepo orchestrators always run, even in deferred mode)
    expect(opResult.status).toBe("passed");
    expect(opResult.isFullSuite).toBe(true);
  });
});

describe("full-suite: strategy ↔ op parity", () => {
  test("PASS case", async () => {
    _regressionStrategyDeps.runVerification = fakeRegressionSuccess() as any;

    const stratResult = await new RegressionStrategy().execute({
      workdir: "/repo",
      storyId: "S-1",
      testCommand: "bun test",
      timeoutSeconds: 60,
      regressionMode: "per-story",
      config: {
        execution: { regressionGate: { enabled: true, acceptOnTimeout: true } },
        quality: { commands: { test: "bun test" } },
      } as any,
    });

    const deps = {
      resolveGateContext: async () => ({ config: {} as any, testCmd: "bun test", fullSuiteTimeout: 60 }),
      runTests: async () => ({
        passed: true,
        failed: 0,
        output: "5 pass\n0 fail",
        parsedSummary: { passed: 5, failed: 0, failures: [] },
        timedOut: false,
      }),
    };

    const opResult = await fullSuiteGateOp.execute(
      { story: { id: "S-1" } as any, workdir: "/repo" },
      { config: { execution: { regressionGate: { enabled: true } } } } as any,
      deps as any,
    );

    expect(stratResult.status).toBe("PASS");
    expect(opResult.status).toBe("passed");
    expect(stratResult.success).toBe(opResult.success);
    expect(opResult.passed).toBe(true);
  });

  test("ENABLED=false → skipped", async () => {
    const stratResult = await new RegressionStrategy().execute({
      workdir: "/repo",
      storyId: "S-1",
      testCommand: "bun test",
      timeoutSeconds: 60,
      regressionMode: "per-story",
      config: {
        execution: { regressionGate: { enabled: false } },
        quality: { commands: { test: "bun test" } },
      } as any,
    });

    const deps = {
      resolveGateContext: async () => ({ config: {} as any, testCmd: "bun test", fullSuiteTimeout: 60 }),
      runTests: async () => ({
        passed: true,
        failed: 0,
        output: "",
        parsedSummary: { passed: 0, failed: 0, failures: [] },
        timedOut: false,
      }),
    };

    const opResult = await fullSuiteGateOp.execute(
      { story: { id: "S-1" } as any, workdir: "/repo" },
      { config: { execution: { regressionGate: { enabled: false } } } } as any,
      deps as any,
    );

    expect(stratResult.status).toBe("SKIPPED");
    expect(opResult.status).toBe("skipped");
    expect(stratResult.success).toBe(opResult.success);
  });

  test("TIMEOUT + acceptOnTimeout=true → passed", async () => {
    _regressionStrategyDeps.runVerification = async () => ({
      status: "TIMEOUT" as const,
      success: false,
      countsTowardEscalation: false,
      output: "",
    });

    const stratResult = await new RegressionStrategy().execute({
      workdir: "/repo",
      storyId: "S-1",
      testCommand: "bun test",
      timeoutSeconds: 60,
      acceptOnTimeout: true,
      regressionMode: "per-story",
      config: {
        execution: { regressionGate: { enabled: true, acceptOnTimeout: true } },
        quality: { commands: { test: "bun test" } },
      } as any,
    });

    const deps = {
      resolveGateContext: async () => ({ config: {} as any, testCmd: "bun test", fullSuiteTimeout: 60 }),
      runTests: async () => ({
        passed: false,
        failed: 0,
        output: "",
        parsedSummary: { passed: 0, failed: 0, failures: [] },
        timedOut: true,
      }),
    };

    const opResult = await fullSuiteGateOp.execute(
      { story: { id: "S-1" } as any, workdir: "/repo" },
      { config: { execution: { regressionGate: { enabled: true, acceptOnTimeout: true } } } } as any,
      deps as any,
    );

    // Strategy: PASS (acceptOnTimeout treated as pass).
    // Op: "passed-on-timeout" (explicit status introduced in issue #1116).
    expect(stratResult.status).toBe("PASS");
    expect(opResult.status).toBe("passed-on-timeout");
    // Both treat as success
    expect(stratResult.success).toBe(true);
    expect(opResult.success).toBe(true);
    expect(opResult.passed).toBe(true);
  });

  test("TIMEOUT + acceptOnTimeout=false → failed", async () => {
    _regressionStrategyDeps.runVerification = async () => ({
      status: "TIMEOUT" as const,
      success: false,
      countsTowardEscalation: false,
      output: "",
    });

    const stratResult = await new RegressionStrategy().execute({
      workdir: "/repo",
      storyId: "S-1",
      testCommand: "bun test",
      timeoutSeconds: 60,
      acceptOnTimeout: false,
      regressionMode: "per-story",
      config: {
        execution: { regressionGate: { enabled: true, acceptOnTimeout: false } },
        quality: { commands: { test: "bun test" } },
      } as any,
    });

    const deps = {
      resolveGateContext: async () => ({ config: {} as any, testCmd: "bun test", fullSuiteTimeout: 60 }),
      runTests: async () => ({
        passed: false,
        failed: 0,
        output: "",
        parsedSummary: { passed: 0, failed: 0, failures: [] },
        timedOut: true,
      }),
    };

    const opResult = await fullSuiteGateOp.execute(
      { story: { id: "S-1" } as any, workdir: "/repo" },
      { config: { execution: { regressionGate: { enabled: true, acceptOnTimeout: false } } } } as any,
      deps as any,
    );

    // Both should fail on timeout
    expect(stratResult.status).toBe("TIMEOUT");
    expect(opResult.status).toBe("timeout");
    expect(stratResult.success).toBe(false);
    expect(opResult.success).toBe(false);
  });
});
