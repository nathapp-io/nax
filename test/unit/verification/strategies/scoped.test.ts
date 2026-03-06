// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { ScopedStrategy, _scopedDeps } from "../../../../src/verification/strategies/scoped";
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
