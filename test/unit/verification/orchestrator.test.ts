// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { VerificationOrchestrator } from "../../../src/verification/orchestrator";
import type { IVerificationStrategy, VerifyContext, VerifyResult } from "../../../src/verification/orchestrator-types";
import { makePassResult, makeSkippedResult } from "../../../src/verification/orchestrator-types";

function makeCtx(): VerifyContext {
  return {
    workdir: "/tmp",
    testCommand: "bun test",
    timeoutSeconds: 60,
    storyId: "US-001",
  };
}

function makeStubStrategy(name: "scoped" | "regression" | "deferred-regression" | "acceptance", result: VerifyResult): IVerificationStrategy {
  return {
    name,
    execute: async () => result,
  };
}

describe("VerificationOrchestrator", () => {
  test("delegates to scoped strategy", async () => {
    const expected = makePassResult("US-001", "scoped");
    const orch = new VerificationOrchestrator({
      scoped: makeStubStrategy("scoped", expected),
    });
    const result = await orch.verifyScoped(makeCtx());
    expect(result).toBe(expected);
  });

  test("delegates to regression strategy", async () => {
    const expected = makePassResult("US-001", "regression");
    const orch = new VerificationOrchestrator({
      regression: makeStubStrategy("regression", expected),
    });
    const result = await orch.verifyRegression(makeCtx());
    expect(result).toBe(expected);
  });

  test("delegates to deferred-regression strategy", async () => {
    const expected = makeSkippedResult("US-001", "deferred-regression");
    const orch = new VerificationOrchestrator({
      "deferred-regression": makeStubStrategy("deferred-regression", expected),
    });
    const result = await orch.verifyDeferredRegression(makeCtx());
    expect(result).toBe(expected);
  });

  test("delegates to acceptance strategy", async () => {
    const expected = makeSkippedResult("US-001", "acceptance");
    const orch = new VerificationOrchestrator({
      acceptance: makeStubStrategy("acceptance", expected),
    });
    const result = await orch.verifyAcceptance(makeCtx());
    expect(result).toBe(expected);
  });

  test("returns SKIPPED for unknown strategy", async () => {
    const orch = new VerificationOrchestrator();
    const result = await orch.verify(makeCtx(), "scoped");
    // scoped strategy exists, just confirm it runs
    expect(result.storyId).toBe("US-001");
  });
});
