// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { ScopedStrategy, _scopedDeps, isMonorepoOrchestratorCommand } from "../../../../src/verification/strategies/scoped";
import type { VerifyContext } from "../../../../src/verification/orchestrator-types";

function makeCtx(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    workdir: "/tmp/test-repo",
    testCommand: "bun test",
    timeoutSeconds: 60,
    storyId: "US-001",
    storyGitRef: "abc123",
    regressionMode: "deferred",
    acceptOnTimeout: true,
    ...overrides,
  };
}

describe("ScopedStrategy", () => {
  test("name is scoped", () => {
    expect(new ScopedStrategy().name).toBe("scoped");
  });

  test("returns SKIPPED when deferred mode and no mapped tests", async () => {
    const saved = { ..._scopedDeps };
    _scopedDeps.getChangedSourceFiles = async () => [];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];

    const result = await new ScopedStrategy().execute(makeCtx({ regressionMode: "deferred" }));

    Object.assign(_scopedDeps, saved);

    expect(result.status).toBe("SKIPPED");
    expect(result.success).toBe(true);
    expect(result.countsTowardEscalation).toBe(false);
  });

  test("runs full suite when inline mode and no mapped tests", async () => {
    const saved = { ..._scopedDeps };
    _scopedDeps.getChangedSourceFiles = async () => [];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.importGrepFallback = async () => [];
    _scopedDeps.regression = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "1 pass",
    });

    const result = await new ScopedStrategy().execute(makeCtx({ regressionMode: "inline" }));

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PASS");
  });

  test("returns PASS when tests pass", async () => {
    const saved = { ..._scopedDeps };
    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts"];
    _scopedDeps.mapSourceToTests = async () => ["test/unit/foo.test.ts"];
    _scopedDeps.buildSmartTestCommand = (_files: string[], cmd: string) => `${cmd} test/unit/foo.test.ts`;
    _scopedDeps.regression = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "5 pass\n0 fail",
    });

    const result = await new ScopedStrategy().execute(makeCtx());

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PASS");
    expect(result.strategy).toBe("scoped");
  });

  test("returns TEST_FAILURE when tests fail", async () => {
    const saved = { ..._scopedDeps };
    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts"];
    _scopedDeps.mapSourceToTests = async () => ["test/unit/foo.test.ts"];
    _scopedDeps.buildSmartTestCommand = (_files: string[], cmd: string) => cmd;
    _scopedDeps.regression = async () => ({
      success: false,
      status: "TEST_FAILURE" as const,
      countsTowardEscalation: true,
      output: "(fail) foo > bar\n1 fail",
    });

    const result = await new ScopedStrategy().execute(makeCtx());

    Object.assign(_scopedDeps, saved);

    expect(result.success).toBe(false);
    expect(result.status).toBe("TEST_FAILURE");
    expect(result.countsTowardEscalation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isMonorepoOrchestratorCommand
// ---------------------------------------------------------------------------

describe("isMonorepoOrchestratorCommand", () => {
  test("turbo run test --filter=...[HEAD~1] is a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("turbo run test --filter=...[HEAD~1]")).toBe(true);
  });

  test("nx affected --target=test is a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("nx affected --target=test")).toBe(true);
  });

  test("bun test is not a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("bun test")).toBe(false);
  });

  test("npm test is not a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("npm test")).toBe(false);
  });

  test("pnpm run --recursive test is not a monorepo orchestrator command", () => {
    expect(isMonorepoOrchestratorCommand("pnpm run --recursive test")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ScopedStrategy — monorepo orchestrator bypass
// ---------------------------------------------------------------------------

describe("ScopedStrategy — monorepo orchestrator bypass", () => {
  test("turbo command: skips smart runner and runs command as-is (not deferred)", async () => {
    const capturedCommands: string[] = [];
    const saved = { ..._scopedDeps };

    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts"];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.regression = async ({ command }: { command: string; workdir: string; timeoutSeconds: number; acceptOnTimeout?: boolean }) => {
      capturedCommands.push(command);
      return { success: true, status: "PASS" as const, countsTowardEscalation: false, output: "1 pass" };
    };

    const turboCtx = makeCtx({
      testCommand: "turbo run test --filter=...[HEAD~1]",
      regressionMode: "deferred",
    });
    const result = await new ScopedStrategy().execute(turboCtx);

    Object.assign(_scopedDeps, saved);

    // Should NOT be skipped/deferred despite regressionMode=deferred
    expect(result.status).not.toBe("SKIPPED");
    expect(result.success).toBe(true);
    // Command must be passed through unchanged (no file path appended)
    expect(capturedCommands[0]).toBe("turbo run test --filter=...[HEAD~1]");
  });

  test("nx command: runs as-is without smart runner interference", async () => {
    const capturedCommands: string[] = [];
    const saved = { ..._scopedDeps };

    _scopedDeps.getChangedSourceFiles = async () => ["src/foo.ts"];
    _scopedDeps.mapSourceToTests = async () => [];
    _scopedDeps.regression = async ({ command }: { command: string; workdir: string; timeoutSeconds: number; acceptOnTimeout?: boolean }) => {
      capturedCommands.push(command);
      return { success: true, status: "PASS" as const, countsTowardEscalation: false, output: "1 pass" };
    };

    const nxCtx = makeCtx({
      testCommand: "nx affected --target=test",
      regressionMode: "deferred",
    });
    await new ScopedStrategy().execute(nxCtx);

    Object.assign(_scopedDeps, saved);

    expect(capturedCommands[0]).toBe("nx affected --target=test");
  });

  test("non-orchestrator command still defers in deferred mode when no tests mapped", async () => {
    const saved = { ..._scopedDeps };

    _scopedDeps.getChangedSourceFiles = async () => [];
    _scopedDeps.mapSourceToTests = async () => [];

    const ctx = makeCtx({ testCommand: "bun test", regressionMode: "deferred" });
    const result = await new ScopedStrategy().execute(ctx);

    Object.assign(_scopedDeps, saved);

    expect(result.status).toBe("SKIPPED");
  });
});
