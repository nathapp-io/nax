// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { RegressionStrategy, _regressionStrategyDeps } from "../../../../src/verification/strategies/regression";
import type { VerifyContext } from "../../../../src/verification/orchestrator-types";
import { DEFAULT_CONFIG } from "../../../../src/config";

function makeCtx(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    workdir: "/tmp/test-repo",
    testCommand: "bun test",
    timeoutSeconds: 120,
    storyId: "US-001",
    acceptOnTimeout: true,
    config: DEFAULT_CONFIG,
    ...overrides,
  };
}

describe("RegressionStrategy", () => {
  test("name is regression", () => {
    expect(new RegressionStrategy().name).toBe("regression");
  });

  test("returns SKIPPED when gate disabled", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        regressionGate: { enabled: false, timeoutSeconds: 120, mode: "inline" as const },
      },
    };
    const result = await new RegressionStrategy().execute(makeCtx({ config }));
    expect(result.status).toBe("SKIPPED");
    expect(result.success).toBe(true);
  });

  test("returns PASS when tests pass", async () => {
    const saved = { ...(_regressionStrategyDeps as any) };
    _regressionStrategyDeps.runVerification = async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "10 pass",
    });

    const result = await new RegressionStrategy().execute(makeCtx());

    Object.assign(_regressionStrategyDeps, saved);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PASS");
    expect(result.strategy).toBe("regression");
  });

  test("accepts TIMEOUT as pass when acceptOnTimeout=true", async () => {
    const saved = { ...(_regressionStrategyDeps as any) };
    _regressionStrategyDeps.runVerification = async () => ({
      success: false,
      status: "TIMEOUT" as const,
      countsTowardEscalation: false,
    });

    const result = await new RegressionStrategy().execute(makeCtx({ acceptOnTimeout: true }));

    Object.assign(_regressionStrategyDeps, saved);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PASS");
  });

  test("returns TEST_FAILURE when tests fail", async () => {
    const saved = { ...(_regressionStrategyDeps as any) };
    _regressionStrategyDeps.runVerification = async () => ({
      success: false,
      status: "TEST_FAILURE" as const,
      countsTowardEscalation: true,
      output: "(fail) x > y\n2 fail",
    });

    const result = await new RegressionStrategy().execute(makeCtx({ acceptOnTimeout: false }));

    Object.assign(_regressionStrategyDeps, saved);

    expect(result.success).toBe(false);
    expect(result.status).toBe("TEST_FAILURE");
  });
});
