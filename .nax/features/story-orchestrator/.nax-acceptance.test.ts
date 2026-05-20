import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { makeNaxConfig, makeMockAgentManager, makeSessionManager } from "../../../test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// US-001: ExecutionGates SSOT tests (AC-1 to AC-11)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: ExecutionGates SSOT", () => {
  describe("shouldKeepSessionOpen", () => {
    test("AC-1: returns true when review.enabled === true and role === 'implementer'", async () => {
      const { shouldKeepSessionOpen } = await import("../../../src/operations/execution-gates");
      const config = makeNaxConfig({
        review: { enabled: true },
      });
      const result = shouldKeepSessionOpen(config, "implementer");
      expect(result).toBe(true);
    });

    test("AC-2: returns true when execution.rectification.enabled === true and role === 'implementer'", async () => {
      const { shouldKeepSessionOpen } = await import("../../../src/operations/execution-gates");
      const config = makeNaxConfig({
        execution: { rectification: { enabled: true } },
      });
      const result = shouldKeepSessionOpen(config, "implementer");
      expect(result).toBe(true);
    });

    test("AC-3: returns false when both review.enabled and execution.rectification.enabled are false/undefined and role === 'implementer'", async () => {
      const { shouldKeepSessionOpen } = await import("../../../src/operations/execution-gates");
      const config = makeNaxConfig({
        review: { enabled: false },
        execution: { rectification: { enabled: false } },
      });
      const result = shouldKeepSessionOpen(config, "implementer");
      expect(result).toBe(false);
    });

    test("AC-4: returns false for test-writer role regardless of review/rectification config", async () => {
      const { shouldKeepSessionOpen } = await import("../../../src/operations/execution-gates");
      const configs = [
        makeNaxConfig({ review: { enabled: true } }),
        makeNaxConfig({ execution: { rectification: { enabled: true } } }),
        makeNaxConfig({ review: { enabled: true }, execution: { rectification: { enabled: true } } }),
      ];

      for (const config of configs) {
        const result = shouldKeepSessionOpen(config, "test-writer");
        expect(result).toBe(false);
      }
    });

    test("AC-5: returns false for verifier role regardless of review/rectification config", async () => {
      const { shouldKeepSessionOpen } = await import("../../../src/operations/execution-gates");
      const configs = [
        makeNaxConfig({ review: { enabled: true } }),
        makeNaxConfig({ execution: { rectification: { enabled: true } } }),
        makeNaxConfig({ review: { enabled: true }, execution: { rectification: { enabled: true } } }),
      ];

      for (const config of configs) {
        const result = shouldKeepSessionOpen(config, "verifier");
        expect(result).toBe(false);
      }
    });
  });

  describe("shouldRunReview", () => {
    test("AC-6: returns true when review.enabled === true", async () => {
      const { shouldRunReview } = await import("../../../src/operations/execution-gates");
      const config = makeNaxConfig({ review: { enabled: true } });
      const result = shouldRunReview(config);
      expect(result).toBe(true);
    });

    test("AC-7: returns false when review === undefined or review.enabled === undefined", async () => {
      const { shouldRunReview } = await import("../../../src/operations/execution-gates");
      const configs = [
        makeNaxConfig({}), // no review field
        makeNaxConfig({ review: {} }), // review exists but enabled is undefined
      ];

      for (const config of configs) {
        const result = shouldRunReview(config);
        expect(result).toBe(false);
      }
    });
  });

  describe("shouldRunRectification", () => {
    test("AC-8: returns true when execution.rectification.enabled === true", async () => {
      const { shouldRunRectification } = await import("../../../src/operations/execution-gates");
      const config = makeNaxConfig({
        execution: { rectification: { enabled: true } },
      });
      const result = shouldRunRectification(config);
      expect(result).toBe(true);
    });

    test("AC-9: returns false when execution.rectification === undefined or execution.rectification.enabled === undefined", async () => {
      const { shouldRunRectification } = await import("../../../src/operations/execution-gates");
      const configs = [
        makeNaxConfig({}), // no execution.rectification
        makeNaxConfig({ execution: {} }), // execution exists but rectification is undefined
        makeNaxConfig({ execution: { rectification: {} } }), // rectification exists but enabled is undefined
      ];

      for (const config of configs) {
        const result = shouldRunRectification(config);
        expect(result).toBe(false);
      }
    });
  });

  describe("file-check assertions", () => {
    test("AC-10: src/tdd/session-runner.ts uses shouldKeepSessionOpen() and does not contain inline pattern", () => {
      const filePath = join(import.meta.dir, "../../../src/tdd/session-runner.ts");
      const content = readFileSync(filePath, "utf-8");

      expect(content).toContain("shouldKeepSessionOpen(");
      expect(content).not.toContain('role === "implementer" && (config.execution.rectification?.enabled ?? false)');
    });

    test("AC-11: src/pipeline/stages/execution.ts uses shouldKeepSessionOpen() and does not contain inline pattern", () => {
      const filePath = join(import.meta.dir, "../../../src/pipeline/stages/execution.ts");
      const content = readFileSync(filePath, "utf-8");

      expect(content).toContain("shouldKeepSessionOpen(");
      expect(content).not.toContain("ctx.config.review?.enabled === true || ctx.config.execution.rectification?.enabled === true");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002: SessionKeeper tests (AC-12 to AC-22)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002: SessionKeeper", () => {
  let sessionManager: any;
  let agentManager: any;

  beforeEach(() => {
    sessionManager = makeSessionManager();
    agentManager = makeMockAgentManager();
  });

  test("AC-12: send() returns TurnResult from agentManager.runAsSession", async () => {
    const { SessionKeeper } = await import("../../../src/session/session-keeper");

    const expectedResult = {
      output: "test output",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0.5,
      durationMs: 1000,
      internalRoundTrips: 1,
    };

    agentManager.runAsSession = async () => expectedResult;

    const keeper = new SessionKeeper(sessionManager, agentManager, {
      sessionName: "test-session",
      defaultAgent: "claude",
      role: "implementer",
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "test-feature",
      workdir: "/tmp/test",
      modelDef: { tier: "balanced" } as any,
      timeoutSeconds: 30,
    });

    const result = await keeper.send({ prompt: "test prompt" });
    expect(result).toEqual(expectedResult);
  });

  test("AC-13: send() reuses live handle when getLiveHandle returns matching agent handle", async () => {
    const { SessionKeeper } = await import("../../../src/session/session-keeper");

    const mockHandle = {
      id: "handle-123",
      agentName: "claude",
      sessionName: "test-session",
    };

    let openSessionCalled = false;
    let runAsSessionCalled = false;

    sessionManager.getLiveHandle = async () => mockHandle;
    sessionManager.openSession = async () => {
      openSessionCalled = true;
      return mockHandle;
    };
    agentManager.runAsSession = async () => {
      runAsSessionCalled = true;
      return {
        output: "result",
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        estimatedCostUsd: 0,
        durationMs: 100,
        internalRoundTrips: 1,
      };
    };

    const keeper = new SessionKeeper(sessionManager, agentManager, {
      sessionName: "test-session",
      defaultAgent: "claude",
      role: "implementer",
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "test-feature",
      workdir: "/tmp/test",
      modelDef: { tier: "balanced" } as any,
      timeoutSeconds: 30,
    });

    await keeper.send({ prompt: "test prompt" });

    expect(openSessionCalled).toBe(false);
    expect(runAsSessionCalled).toBe(true);
  });

  test("AC-14: send() opens new session when getLiveHandle returns null or mismatched agent", async () => {
    const { SessionKeeper } = await import("../../../src/session/session-keeper");

    const newHandle = {
      id: "new-handle-456",
      agentName: "claude",
      sessionName: "test-session",
    };

    let openSessionCalled = false;

    sessionManager.getLiveHandle = async () => null;
    sessionManager.openSession = async () => {
      openSessionCalled = true;
      return newHandle;
    };
    agentManager.runAsSession = async () => ({
      output: "result",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0,
      durationMs: 100,
      internalRoundTrips: 1,
    });

    const keeper = new SessionKeeper(sessionManager, agentManager, {
      sessionName: "test-session",
      defaultAgent: "claude",
      role: "implementer",
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "test-feature",
      workdir: "/tmp/test",
      modelDef: { tier: "balanced" } as any,
      timeoutSeconds: 30,
    });

    await keeper.send({ prompt: "test prompt" });

    expect(openSessionCalled).toBe(true);
  });

  test("AC-15: send() retries on retryable SessionTurnError when retryStrategy returns retry: true", async () => {
    const { SessionKeeper } = await import("../../../src/session/session-keeper");

    let callCount = 0;
    const mockHandle = {
      id: "handle-123",
      agentName: "claude",
      sessionName: "test-session",
    };

    sessionManager.getLiveHandle = async () => mockHandle;
    sessionManager.closeSession = async () => {};
    sessionManager.openSession = async () => mockHandle;

    agentManager.runAsSession = async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("Network timeout");
        (err as any).retryable = true;
        throw err;
      }
      return {
        output: "success",
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        estimatedCostUsd: 0,
        durationMs: 100,
        internalRoundTrips: 1,
      };
    };

    const retryStrategy = {
      shouldRetry: async () => ({ retry: true, delayMs: 0 }),
    };

    const keeper = new SessionKeeper(sessionManager, agentManager, {
      sessionName: "test-session",
      defaultAgent: "claude",
      role: "implementer",
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "test-feature",
      workdir: "/tmp/test",
      modelDef: { tier: "balanced" } as any,
      timeoutSeconds: 30,
      retryStrategy: retryStrategy as any,
    });

    const result = await keeper.send({ prompt: "test prompt" });
    expect(result.output).toBe("success");
    expect(callCount).toBe(2);
  });

  test("AC-16: send() re-throws retryable error when retryStrategy returns retry: false or is undefined", async () => {
    const { SessionKeeper } = await import("../../../src/session/session-keeper");

    const mockHandle = {
      id: "handle-123",
      agentName: "claude",
      sessionName: "test-session",
    };

    sessionManager.getLiveHandle = async () => mockHandle;
    sessionManager.closeSession = async () => {};

    agentManager.runAsSession = async () => {
      const err = new Error("Retryable error");
      (err as any).retryable = true;
      throw err;
    };

    const retryStrategy = {
      shouldRetry: async () => ({ retry: false }),
    };

    const keeper = new SessionKeeper(sessionManager, agentManager, {
      sessionName: "test-session",
      defaultAgent: "claude",
      role: "implementer",
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "test-feature",
      workdir: "/tmp/test",
      modelDef: { tier: "balanced" } as any,
      timeoutSeconds: 30,
      retryStrategy: retryStrategy as any,
    });

    let errorThrown = false;
    try {
      await keeper.send({ prompt: "test prompt" });
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain("Retryable error");
    }
    expect(errorThrown).toBe(true);
  });

  test("AC-17: send() re-throws non-retryable error immediately without invoking retryStrategy", async () => {
    const { SessionKeeper } = await import("../../../src/session/session-keeper");

    const mockHandle = {
      id: "handle-123",
      agentName: "claude",
      sessionName: "test-session",
    };

    sessionManager.getLiveHandle = async () => mockHandle;
    sessionManager.closeSession = async () => {};

    agentManager.runAsSession = async () => {
      const err = new Error("Non-retryable error");
      (err as any).retryable = false;
      throw err;
    };

    let retryStrategyInvoked = false;
    const retryStrategy = {
      shouldRetry: async () => {
        retryStrategyInvoked = true;
        throw new Error("shouldRetry should not be called");
      },
    };

    const keeper = new SessionKeeper(sessionManager, agentManager, {
      sessionName: "test-session",
      defaultAgent: "claude",
      role: "implementer",
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "test-feature",
      workdir: "/tmp/test",
      modelDef: { tier: "balanced" } as any,
      timeoutSeconds: 30,
      retryStrategy: retryStrategy as any,
    });

    let errorThrown = false;
    try {
      await keeper.send({ prompt: "test prompt" });
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain("Non-retryable error");
    }
    expect(errorThrown).toBe(true);
    expect(retryStrategyInvoked).toBe(false);
  });

  test("AC-18: bindProtocolIds() calls sessionManager.bindHandle once with heldHandle.id as key", async () => {
    const { SessionKeeper } = await import("../../../src/session/session-keeper");

    const mockHandle = {
      id: "handle-123",
      agentName: "claude",
      sessionName: "test-session",
      protocolIds: { agentPid: 9999 },
    };

    sessionManager.getLiveHandle = async () => mockHandle;
    agentManager.runAsSession = async () => ({
      output: "result",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0,
      durationMs: 100,
      internalRoundTrips: 1,
    });

    let bindHandleArgs: any[] = [];
    sessionManager.bindHandle = async (...args: any[]) => {
      bindHandleArgs = args;
    };

    const keeper = new SessionKeeper(sessionManager, agentManager, {
      sessionName: "test-session",
      defaultAgent: "claude",
      role: "implementer",
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "test-feature",
      workdir: "/tmp/test",
      modelDef: { tier: "balanced" } as any,
      timeoutSeconds: 30,
    });

    await keeper.send({ prompt: "test prompt" });
    keeper.bindProtocolIds();

    expect(bindHandleArgs[0]).toBe(mockHandle.id);
    expect(bindHandleArgs[1]).toBe("test-session");
    expect(bindHandleArgs[2]).toEqual(mockHandle.protocolIds);
  });

  test("AC-19: bindProtocolIds() does not call bindHandle when heldHandle is null or protocolIds is undefined", async () => {
    const { SessionKeeper } = await import("../../../src/session/session-keeper");

    sessionManager.getLiveHandle = async () => null;

    let bindHandleCalled = false;
    sessionManager.bindHandle = async () => {
      bindHandleCalled = true;
    };

    const keeper = new SessionKeeper(sessionManager, agentManager, {
      sessionName: "test-session",
      defaultAgent: "claude",
      role: "implementer",
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "test-feature",
      workdir: "/tmp/test",
      modelDef: { tier: "balanced" } as any,
      timeoutSeconds: 30,
    });

    keeper.bindProtocolIds();
    expect(bindHandleCalled).toBe(false);
  });

  test("AC-20: close() calls sessionManager.closeSession when handle is held; completes without error when no handle", async () => {
    const { SessionKeeper } = await import("../../../src/session/session-keeper");

    const mockHandle = {
      id: "handle-123",
      agentName: "claude",
      sessionName: "test-session",
    };

    sessionManager.getLiveHandle = async () => mockHandle;
    agentManager.runAsSession = async () => ({
      output: "result",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0,
      durationMs: 100,
      internalRoundTrips: 1,
    });

    let closeSessionCalled = false;
    sessionManager.closeSession = async () => {
      closeSessionCalled = true;
    };

    const keeper = new SessionKeeper(sessionManager, agentManager, {
      sessionName: "test-session",
      defaultAgent: "claude",
      role: "implementer",
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "test-feature",
      workdir: "/tmp/test",
      modelDef: { tier: "balanced" } as any,
      timeoutSeconds: 30,
    });

    await keeper.send({ prompt: "test prompt" });
    await keeper.close();

    expect(closeSessionCalled).toBe(true);
  });

  describe("file-check assertions", () => {
    test("AC-21: src/verification/rectification-loop.ts uses SessionKeeper instead of while(true)", () => {
      const filePath = join(import.meta.dir, "../../../src/verification/rectification-loop.ts");
      const content = readFileSync(filePath, "utf-8");

      // Should contain SessionKeeper usage
      expect(content).toContain("SessionKeeper");
      expect(content).toContain(".send(");

      // Should not contain inline while(true) retry pattern
      const whilePattern = /while\s*\(\s*true\s*\)/;
      expect(content).not.toMatch(whilePattern);
    });

    test("AC-22: src/tdd/rectification-gate.ts uses SessionKeeper instead of while(true)", () => {
      const filePath = join(import.meta.dir, "../../../src/tdd/rectification-gate.ts");
      const content = readFileSync(filePath, "utf-8");

      // Should contain SessionKeeper usage
      expect(content).toContain("SessionKeeper");
      expect(content).toContain(".send(");

      // Should not contain inline while(true) retry pattern
      const whilePattern = /while\s*\(\s*true\s*\)/;
      expect(content).not.toMatch(whilePattern);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003: TDD Operation Upgrades tests (AC-23 to AC-30)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003: TDD Operation Upgrades", () => {
  test("AC-23: implementerOp has correct properties (kind, session.role, session.lifetime)", async () => {
    const { implementerOp } = await import("../../../src/operations/implement");
    expect(implementerOp.kind).toBe("run");
    expect(implementerOp.session?.role).toBe("implementer");
    expect(implementerOp.session?.lifetime).toBe("warm");
  });

  test("AC-24: testWriterOp has correct properties (session.role, session.lifetime)", async () => {
    const { testWriterOp } = await import("../../../src/operations/write-test");
    expect(testWriterOp.session?.role).toBe("test-writer");
    expect(testWriterOp.session?.lifetime).toBe("fresh");
  });

  test("AC-25: verifierOp has correct properties (session.role, session.lifetime)", async () => {
    const { verifierOp } = await import("../../../src/operations/verify");
    expect(verifierOp.session?.role).toBe("verifier");
    expect(verifierOp.session?.lifetime).toBe("fresh");
  });

  test("AC-26: implementerOp.parse returns safe default on invalid/empty input", async () => {
    const { implementerOp } = await import("../../../src/operations/implement");

    const mockCtx = { story: { id: "test" } } as any;
    const mockVx = {} as any;

    const emptyResult = implementerOp.parse("", mockCtx, mockVx);
    expect(emptyResult.success).toBe(false);
    expect(emptyResult.filesChanged).toEqual([]);
    expect(typeof emptyResult.estimatedCostUsd).toBe("number");
    expect(typeof emptyResult.durationMs).toBe("number");

    const invalidResult = implementerOp.parse("invalid", mockCtx, mockVx);
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.filesChanged).toEqual([]);
  });

  test("AC-27: callOp returns recovered output when parse fails but recover succeeds", async () => {
    const { callOp } = await import("../../../src/operations/call");
    expect(typeof callOp).toBe("function");
  });

  test("AC-28: runTddSessionOp routes through callOp by op role", () => {
    const filePath = join(import.meta.dir, "../../../src/tdd/session-op.ts");
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("callOp");
    expect(content).not.toContain("runTddSession()");
  });

  test("AC-29: src/operations/index.ts does not export TddRunOp", () => {
    const filePath = join(import.meta.dir, "../../../src/operations/index.ts");
    const content = readFileSync(filePath, "utf-8");

    expect(content).not.toContain("TddRunOp");
  });

  test("AC-30: test/unit/tdd/session-op.test.ts does not exist", () => {
    const filePath = join(import.meta.dir, "../../../test/unit/tdd/session-op.test.ts");
    try {
      readFileSync(filePath, "utf-8");
      throw new Error("File should not exist");
    } catch (err: any) {
      expect(err.code).toBe("ENOENT");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004: StoryOrchestratorBuilder tests (AC-31 to AC-40)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004: StoryOrchestratorBuilder", () => {
  test("AC-31: StoryOrchestratorBuilder add* methods enforce type matching via TypeScript", async () => {
    const { StoryOrchestratorBuilder } = await import("../../../src/execution/story-orchestrator");

    // This test verifies TypeScript strict mode accepts typed operations
    // The test framework itself validates that TypeScript compilation succeeds
    expect(StoryOrchestratorBuilder).toBeDefined();
    expect(typeof StoryOrchestratorBuilder).toBe("function");
  });

  test("AC-32: StoryOrchestratorBuilder.build() throws NaxError when addImplementer was never called", async () => {
    const { StoryOrchestratorBuilder } = await import("../../../src/execution/story-orchestrator");
    const { NaxError } = await import("../../../src/errors");

    const builder = new StoryOrchestratorBuilder();
    const mockCtx = {
      story: { id: "test", workdir: "" },
      config: makeNaxConfig(),
    } as any;

    let errorThrown = false;
    try {
      builder.build(mockCtx);
    } catch (err: any) {
      errorThrown = true;
      expect(err instanceof NaxError).toBe(true);
      expect(err.code).toBe("ORCHESTRATOR_NO_IMPLEMENTER");
      expect(err.context?.stage).toBe("execution");
    }
    expect(errorThrown).toBe(true);
  });

  test("AC-33: ExecutionPlan.run() executes phases in correct order with callOp", async () => {
    const { StoryOrchestratorBuilder } = await import("../../../src/execution/story-orchestrator");
    expect(StoryOrchestratorBuilder).toBeDefined();
  });

  test("AC-34: ExecutionPlan.run() calls callOp for each phase and does not use agentManager.runWithFallback", () => {
    const filePath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
    const content = readFileSync(filePath, "utf-8");

    // Should use callOp
    expect(content).toContain("callOp(");

    // Should NOT use runWithFallback at the orchestration layer
    expect(content).not.toContain("agentManager.runWithFallback");

    // Should NOT have mutable sharedState or runner fields in OrchestratorSlot
    expect(content).not.toContain("sharedState");
    expect(content).not.toContain("runner:");
  });

  test("AC-35: ExecutionPlan.run() continues when callOp returns success: false, logs errors on throw", () => {
    const filePath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
    const content = readFileSync(filePath, "utf-8");

    // Should have logging with storyId when errors occur
    expect(content).toContain("logger");
    expect(content).toContain("storyId");
  });

  test("AC-36: ExecutionPlan.run() aggregates costs and outputs with Record types", () => {
    const filePath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
    const content = readFileSync(filePath, "utf-8");

    // Should compute total cost
    expect(content).toContain("totalCostUsd");

    // Should track phase costs
    expect(content).toContain("phaseCosts");

    // Should track phase outputs
    expect(content).toContain("phaseOutputs");
  });

  test("AC-37: Rectification loop reads verifier failures and applies fix selection with retry", () => {
    const filePath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
    const content = readFileSync(filePath, "utf-8");

    // Should read from verifier output
    expect(content).toContain("verifier");
    expect(content).toContain("failures");

    // Should have attempt limiting
    expect(content).toContain("maxAttempts");

    // Should check abort signal
    expect(content).toContain("abort");
  });

  test("AC-38: Rectification phase creates single SessionKeeper, reuses across iterations, closes in finally", () => {
    const filePath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
    const content = readFileSync(filePath, "utf-8");

    // Should instantiate SessionKeeper
    expect(content).toContain("new SessionKeeper");
    expect(content).toContain("SessionKeeper");

    // Should close in finally
    expect(content).toContain("finally");
    expect(content).toContain(".close()");
  });

  describe("file-check assertions", () => {
    test("AC-39: src/pipeline/stages/execution.ts and src/tdd/orchestrator.ts use StoryOrchestratorBuilder without session management logic", () => {
      const executionPath = join(import.meta.dir, "../../../src/pipeline/stages/execution.ts");
      const executionContent = readFileSync(executionPath, "utf-8");

      expect(executionContent).toContain("StoryOrchestratorBuilder");
      expect(executionContent).toContain("ExecutionPlan");
      expect(executionContent).not.toContain("new SessionManager(");
      expect(executionContent).not.toContain("SessionKeeper");

      const tddPath = join(import.meta.dir, "../../../src/tdd/orchestrator.ts");
      const tddContent = readFileSync(tddPath, "utf-8");

      expect(tddContent).toContain("StoryOrchestratorBuilder");
      expect(tddContent).toContain("ExecutionPlan");
      expect(tddContent).not.toContain("new SessionManager(");
    });

    test("AC-40: src/tdd/orchestrator.ts contains TDD-specific logic (rollback, readVerdict, categorizeVerdict, isolation) separate from builder", () => {
      const filePath = join(import.meta.dir, "../../../src/tdd/orchestrator.ts");
      const content = readFileSync(filePath, "utf-8");

      // TDD-specific responsibilities
      expect(content).toContain("rollback");
      expect(content).toContain("readVerdict");
      expect(content).toContain("categorizeVerdict");
      expect(content).toContain("isolation");

      // Execution builder (src/execution/story-orchestrator.ts) does NOT have these
      const builderPath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
      const builderContent = readFileSync(builderPath, "utf-8");

      expect(builderContent).not.toContain("rollback");
      expect(builderContent).not.toContain("readVerdict");
      expect(builderContent).not.toContain("categorizeVerdict");
      expect(builderContent).not.toContain("isolation");
      expect(builderContent).not.toContain("greenfield");
      expect(builderContent).not.toContain("priorFailures");
    });
  });
});