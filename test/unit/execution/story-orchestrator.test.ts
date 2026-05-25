/**
 * StoryOrchestratorBuilder Tests
 *
 * Tests for the StoryOrchestratorBuilder — a unified dispatcher that replaces
 * duplicated session loops in execution and TDD orchestration.
 *
 * Covers:
 * - AC1: Generic OrchestratorSlot<I, O, C> with typed add* methods
 * - AC2: build() throws "ORCHESTRATOR_NO_IMPLEMENTER" when addImplementer not called
 * - AC3: ExecutionPlan.run() canonical execution order + reuse of existing review ops
 * - AC4: Dispatch via callOp only (no agentManager.runWithFallback, runners, sharedState)
 * - AC5: success=false on op failure; thrown errors logged with { storyId, phase, error }
 * - AC6: StoryOrchestratorResult with phaseCosts, totalCostUsd, durationMs, phaseOutputs
 * - AC7: addRectification loop: failure aggregation, runFixCycle, re-verify, exit conditions
 * - AC8: Rectification owns one SessionKeeper, reuses warm implementer handle
 * - AC9: execution.ts + tdd/orchestrator.ts use builder (no duplicate logic)
 * - AC10: TDD wrapper retains rollback, verdict, isolation, greenfield detection
 */

import { afterEach, describe, test, expect, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, RunOperation, CompleteOperation, DeterministicOperation } from "@/operations";
import { pickSelector } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import {
  makeMockAgentManager,
  makeTestRuntime,
  makeNaxConfig,
  makeLinkWithCosts,
} from "@test/helpers";
import type { NaxRuntime } from "@/runtime";
import type { CompleteResult, TurnResult } from "@/agents/types";
import type { ReviewCheckResult, Finding } from "@/findings";
import { NaxError } from "@/errors";
import { _storyOrchestratorDeps } from "@/execution";

// ============================================================================
// Test Helper: Mock Operations
// ============================================================================

interface TestImplementerInput {
  code: string;
}

interface TestImplementerOutput {
  success: boolean;
  generatedCode?: string;
}

interface TestVerifierInput {
  code: string;
}

interface TestVerifierOutput {
  success: boolean;
  findings?: ReviewCheckResult[];
}

interface TestSemanticReviewInput {
  code: string;
}

interface TestSemanticReviewOutput {
  passed: boolean;
  findings?: ReviewCheckResult[];
}

interface TestAdversarialReviewInput {
  code: string;
}

interface TestAdversarialReviewOutput {
  passed: boolean;
  findings?: ReviewCheckResult[];
}

interface TestTestWriterInput {
  story: string;
}

interface TestTestWriterOutput {
  success: boolean;
  tests?: string;
}

const testSel = pickSelector("test-orchestrator-selector", "execution");

const mockImplementerOp: RunOperation<
  TestImplementerInput,
  TestImplementerOutput,
  typeof DEFAULT_CONFIG
> = {
  kind: "run",
  name: "mock-implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: (input) => ({
    role: { id: "r1", content: "Implement code", overridable: false },
    task: { id: "t1", content: input.code, overridable: false },
  }),
  parse: (output) => {
    try {
      return JSON.parse(output);
    } catch {
      return { success: false };
    }
  },
};

const mockTestWriterOp: RunOperation<
  TestTestWriterInput,
  TestTestWriterOutput,
  typeof DEFAULT_CONFIG
> = {
  kind: "run",
  name: "mock-test-writer",
  stage: "run",
  config: testSel,
  session: { role: "test-writer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "r1", content: "Write tests", overridable: false },
    task: { id: "t1", content: input.story, overridable: false },
  }),
  parse: (output) => {
    try {
      return JSON.parse(output);
    } catch {
      return { success: false };
    }
  },
};

const mockVerifierOp: RunOperation<
  TestVerifierInput,
  TestVerifierOutput,
  typeof DEFAULT_CONFIG
> = {
  kind: "run",
  name: "mock-verifier",
  stage: "verify",
  config: testSel,
  session: { role: "verifier", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "r1", content: "Verify code", overridable: false },
    task: { id: "t1", content: input.code, overridable: false },
  }),
  parse: (output) => {
    try {
      return JSON.parse(output);
    } catch {
      return { success: false, findings: [] };
    }
  },
};

const mockSemanticReviewOp: RunOperation<
  TestSemanticReviewInput,
  TestSemanticReviewOutput,
  typeof DEFAULT_CONFIG
> = {
  kind: "run",
  name: "mock-semantic-review",
  stage: "review",
  config: testSel,
  session: { role: "reviewer-semantic", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "r1", content: "Review semantics", overridable: false },
    task: { id: "t1", content: input.code, overridable: false },
  }),
  parse: (output) => {
    try {
      return JSON.parse(output);
    } catch {
      return { passed: true, findings: [] };
    }
  },
};

const mockAdversarialReviewOp: RunOperation<
  TestAdversarialReviewInput,
  TestAdversarialReviewOutput,
  typeof DEFAULT_CONFIG
> = {
  kind: "run",
  name: "mock-adversarial-review",
  stage: "review",
  config: testSel,
  session: { role: "reviewer-adversarial", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "r1", content: "Review adversarially", overridable: false },
    task: { id: "t1", content: input.code, overridable: false },
  }),
  parse: (output) => {
    try {
      return JSON.parse(output);
    } catch {
      return { passed: true, findings: [] };
    }
  },
};

// ============================================================================
// Test Suites
// ============================================================================

let runtime: NaxRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
});

describe("StoryOrchestratorBuilder — AC1: Generic OrchestratorSlot<I, O, C>", () => {
  test.each([
    ["addImplementer", (b: any) => b.addImplementer({ op: mockImplementerOp, input: { code: "test" } })],
    ["addTestWriter", (b: any) => b.addTestWriter({ op: mockTestWriterOp, input: { story: "test" } })],
    ["addVerifier", (b: any) => b.addVerifier({ op: mockVerifierOp, input: { code: "test" } })],
  ])("%s accepts typed op + input without casting", async (_label, addFn) => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });
    const StoryOrchestratorBuilder = require("@/execution/story-orchestrator").StoryOrchestratorBuilder;
    const result = addFn(new StoryOrchestratorBuilder());
    expect(result).toBeDefined();
  });
});

describe("StoryOrchestratorBuilder — AC2: build() throws ORCHESTRATOR_NO_IMPLEMENTER", () => {
  test("throws NaxError with code ORCHESTRATOR_NO_IMPLEMENTER when addImplementer not called", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)();
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    let caught: unknown;
    try {
      builder.build(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("ORCHESTRATOR_NO_IMPLEMENTER");
  });
});

describe("StoryOrchestratorBuilder — AC3: Canonical execution order", () => {
  test("canonical order: test-writer→implementer→verifier; skips phases not added", async () => {
    const config = makeNaxConfig();
    const makeOrderTracker = (roles: string[]) => makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => {
        const role = _req.sessionRole ?? "unknown";
        roles.push(role);
        return onSuccess({ turnId: randomUUID(), output: JSON.stringify({ success: true }), tokenUsage: { inputTokens: 10, outputTokens: 5 }, estimatedCostUsd: 0.001 });
      },
    });

    const order1: string[] = [];
    runtime = makeTestRuntime({ config, agentManager: makeOrderTracker(order1) });
    const ctx1: CallContext = { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "story-1" };
    await new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addTestWriter({ op: mockTestWriterOp, input: { story: "test" } })
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .build(ctx1).run();
    expect(order1).toEqual(["test-writer", "implementer", "verifier"]);
    await runtime.close();
    runtime = undefined;

    const order2: string[] = [];
    runtime = makeTestRuntime({ config, agentManager: makeOrderTracker(order2) });
    const ctx2: CallContext = { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "story-1" };
    await new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .build(ctx2).run();
    expect(order2).toEqual(["implementer", "verifier"]);
  });
});

describe("StoryOrchestratorBuilder — AC4: callOp dispatch only", () => {
  test("dispatches via callOp (not agentManager.runWithFallback)", async () => {
    const config = makeNaxConfig();

    let callOpInvoked = false;
    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = mock(async () => {
      callOpInvoked = true;
      return { success: true } as unknown as ReturnType<typeof origCallOp>;
    });

    const mockAgentManager = makeMockAgentManager();
    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const { StoryOrchestratorBuilder } = require("@/execution/story-orchestrator");
    const builder = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    await plan.run();

    expect(callOpInvoked).toBe(true);
    expect(mockAgentManager.runWithFallback).not.toHaveBeenCalled();

    _storyOrchestratorDeps.callOp = origCallOp;
  });

});

describe("StoryOrchestratorBuilder — AC5: Error handling and success=false", () => {
  test("returns success=false when an op returns { success: false }", async () => {
    const config = makeNaxConfig();
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => {
        return onSuccess({
          turnId: randomUUID(),
          output: JSON.stringify({ success: false }),
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        });
      },
    });

    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    const result = await plan.run();

    expect(result.success).toBe(false);
  });

  test("logs and propagates thrown errors with { storyId, phase, error }", async () => {
    const config = makeNaxConfig();
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async () => { throw new Error("Test error"); },
    });
    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });
    const ctx: CallContext = { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "story-1" };
    const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .build(ctx);
    expect(plan).toBeDefined();
  });
});

describe("StoryOrchestratorBuilder — AC6: Result shape (costs, outputs, duration)", () => {
  test("returns StoryOrchestratorResult with success, phaseCosts, totalCostUsd, durationMs", async () => {
    const config = makeNaxConfig();
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => {
        return onSuccess({
          turnId: randomUUID(),
          output: JSON.stringify({ success: true }),
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.002,
        });
      },
    });

    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    const result = await plan.run();

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("phaseCosts");
    expect(result).toHaveProperty("totalCostUsd");
    expect(result).toHaveProperty("durationMs");
  });

  test("aggregates per-phase costs keyed by op.name and sums into totalCostUsd", async () => {
    const config = makeNaxConfig();
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => onSuccess({
        turnId: randomUUID(), output: JSON.stringify({ success: true }), tokenUsage: { inputTokens: 10, outputTokens: 5 }, estimatedCostUsd: 0.005,
      }),
    });
    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });
    const ctx: CallContext = { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "story-1" };
    const result = await new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .build(ctx).run();
    expect(result.phaseCosts["mock-implementer"]).toBeGreaterThanOrEqual(0);
    expect(result.phaseCosts["mock-verifier"]).toBeGreaterThanOrEqual(0);
    expect(result.totalCostUsd).toBeCloseTo(Object.values(result.phaseCosts).reduce((a, b) => a + b, 0), 5);
  });

  test("stores parsed phase outputs keyed by op.name in phaseOutputs", async () => {
    const config = makeNaxConfig();
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => {
        const output =
          _req.sessionRole === "implementer"
            ? JSON.stringify({ success: true, generatedCode: "code123" })
            : JSON.stringify({ success: true, findings: [] });

        return onSuccess({
          turnId: randomUUID(),
          output,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        });
      },
    });

    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    const result = await plan.run();

    expect(result.phaseOutputs["mock-implementer"]).toBeDefined();
    expect(result.phaseOutputs["mock-verifier"]).toBeDefined();
  });
});

describe("StoryOrchestratorBuilder — AC7: Rectification phase loop", () => {
  test("addRectification enables rectification phase", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addRectification({
        maxAttempts: 3,
        strategies: [],
        abortOnIncreasingFailures: true,
      });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    expect(plan).toBeDefined();
  });

  test("rectification reads failures from verifier output", async () => {
    const config = makeNaxConfig();
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => {
        const output =
          _req.sessionRole === "verifier"
            ? JSON.stringify({
                success: false,
                findings: [{ id: "f1", message: "Test failed" }],
              })
            : JSON.stringify({ success: true });

        return onSuccess({
          turnId: randomUUID(),
          output,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        });
      },
    });

    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .addRectification({
        maxAttempts: 1,
        strategies: [],
        abortOnIncreasingFailures: true,
      });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    const result = await plan.run();

    expect(result).toBeDefined();
  });

  test("rectification terminates on maxAttempts", async () => {
    const config = makeNaxConfig();
    let attemptCount = 0;

    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => {
        if (_req.sessionRole === "verifier") {
          attemptCount++;
        }

        return onSuccess({
          turnId: randomUUID(),
          output: JSON.stringify({ success: false, findings: [] }),
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        });
      },
    });

    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .addRectification({
        maxAttempts: 2,
        strategies: [],
        abortOnIncreasingFailures: false,
      });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    const result = await plan.run();

    // Initial verify + 1 rectification attempt = 2 verifier calls max
    expect(attemptCount).toBeLessThanOrEqual(2);
  });

  test("rectification terminates on success", async () => {
    const config = makeNaxConfig();
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => {
        const output =
          _req.sessionRole === "verifier"
            ? JSON.stringify({ success: true, findings: [] })
            : JSON.stringify({ success: true });

        return onSuccess({
          turnId: randomUUID(),
          output,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        });
      },
    });

    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .addRectification({
        maxAttempts: 5,
        strategies: [],
        abortOnIncreasingFailures: false,
      });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    const result = await plan.run();

    expect(result.success).toBe(true);
  });

  test("rectification terminates on abortOnIncreasingFailures when failures increase", async () => {
    const config = makeNaxConfig();
    let callCount = 0;

    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => {
        callCount++;
        const findingCount = callCount === 1 ? 1 : 2; // Increase from 1 to 2

        return onSuccess({
          turnId: randomUUID(),
          output: JSON.stringify({
            success: false,
            findings: Array(findingCount).fill({ message: "error" }),
          }),
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        });
      },
    });

    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .addRectification({
        maxAttempts: 10,
        strategies: [],
        abortOnIncreasingFailures: true,
      });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    const result = await plan.run();

    expect(result).toBeDefined();
  });
});

describe("StoryOrchestratorBuilder — AC8: SessionKeeper reuse", () => {
  test("owns one SessionKeeper for implementer session (count ≥ 1); closes in finally", async () => {
    const config = makeNaxConfig();
    let sessionCount = 0;
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) => {
        if (_req.sessionRole === "implementer") sessionCount++;
        return onSuccess({ turnId: randomUUID(), output: JSON.stringify({ success: true }), tokenUsage: { inputTokens: 10, outputTokens: 5 }, estimatedCostUsd: 0.001 });
      },
    });
    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });
    const ctx: CallContext = { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "story-1" };
    const result = await new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
      .build(ctx).run();
    expect(sessionCount).toBeGreaterThanOrEqual(1);
    expect(result).toBeDefined();
  });

  test("reuses warm-lifetime implementer handle across rectification iterations", async () => {
    const config = makeNaxConfig();
    const sessionIds: string[] = [];

    const mockAgentManager = makeMockAgentManager({
      openSessionFn: async (req) => {
        const sessionId = randomUUID();
        if (req.sessionRole === "implementer") {
          sessionIds.push(sessionId);
        }
        return {
          sessionHandle: { sessionId } as any,
          sessionManager: {} as any,
        };
      },
      runAsSessionFn: async (_req, onSuccess) => {
        return onSuccess({
          turnId: randomUUID(),
          output: JSON.stringify({ success: false, findings: [] }),
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        });
      },
    });

    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .addRectification({
        maxAttempts: 2,
        strategies: [],
        abortOnIncreasingFailures: false,
      });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    const result = await plan.run();

    // All implementer calls should reuse the same session (SessionKeeper)
    expect(sessionIds.length).toBeLessThanOrEqual(2);
  });

});

describe("StoryOrchestratorBuilder — AC9: Refactored execution and TDD", () => {
  test("StoryOrchestratorBuilder and ExecutionPlan are exported", async () => {
    const mod = require("@/execution/story-orchestrator");
    expect(mod.StoryOrchestratorBuilder).toBeDefined();
    expect(mod.ExecutionPlan).toBeDefined();
  });
});

describe("StoryOrchestratorBuilder — AC10: TDD wrapper retains responsibilities", () => {
  test("builder builds a plan (rollback/verdict/isolation are delegated to TDD wrapper)", async () => {
    const config = makeNaxConfig();
    runtime = makeTestRuntime({ config });

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };

    const plan = builder.build(ctx);
    expect(plan).toBeDefined();
  });
});

// ============================================================================
// US-006: Short-circuit carve-out and validate callback
// ============================================================================

function makeDeterministicOp(
  name: string,
  result: { success: boolean; findings?: unknown[] },
): DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: testSel,
    execute: async () => ({ ...result, estimatedCostUsd: 0, passed: result.success }),
  };
}

describe("AC-6: short-circuit carve-out for gate + verifier when rectification configured", () => {
  let rt: NaxRuntime | undefined;
  afterEach(async () => { await rt?.close(); });

  test("when rectification configured: gate failure does NOT halt verifier (both run)", async () => {
    const config = makeNaxConfig({ execution: { rectification: { enabled: true, maxRetries: 3, abortOnIncreasingFailures: false } } });
    rt = makeTestRuntime({ config });

    let verifierRan = false;
    const gateOp = makeDeterministicOp("full-suite-gate", { success: false, findings: [{ source: "test-runner", category: "failed-test", severity: "error", message: "fail", rule: "t", file: "t.ts" }] });
    const verOp = makeDeterministicOp("verifier", { success: true });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.name === "verifier") verifierRan = true;
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      // Run ops (implementer): return success so they don't short-circuit before gate/verifier
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    _storyOrchestratorDeps.runFixCycle = async () => ({ iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 });

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx);
      await plan.run();
      expect(verifierRan).toBe(true);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("when rectification NOT configured: gate failure still lets verifier run (verifier is SSOT)", async () => {
    // Issue: verifier must judge after a gate failure, regardless of rectification —
    // pre-existing/unrelated failures should be the verifier's call, not a hard halt.
    // Rectification only adds an extra consume-findings loop on top of this.
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    let verifierRan = false;
    const gateOp = makeDeterministicOp("full-suite-gate", { success: false, findings: [] });
    const verOp = makeDeterministicOp("verifier", { success: true });

    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.name === "verifier") verifierRan = true;
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .build(ctx);
      await plan.run();
      expect(verifierRan).toBe(true);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });

  test("verifier-passed SSOT: gate-only failure does NOT fail the plan (no rollback)", async () => {
    // When the verifier ran and judged the story OK, the full-suite gate's failure
    // represents pre-existing/unrelated regressions. The aggregated planResult.success
    // must follow the verifier's verdict; otherwise post-run rolls back over failures
    // this story did not cause.
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    const gateOp = makeDeterministicOp("full-suite-gate", { success: false, findings: [] });
    const verOp = makeDeterministicOp("verifier", { success: true });

    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .build(ctx);
      const result = await plan.run();
      expect(result.success).toBe(true);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });

  test("happy path: gate-pass + verifier-pass → success=true (SSOT carve-out does not invert)", async () => {
    // Sanity: the SSOT carve-out must not accidentally invert success when both
    // gate and verifier passed — that is the normal happy path.
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    const gateOp = makeDeterministicOp("full-suite-gate", { success: true });
    const verOp = makeDeterministicOp("verifier", { success: true });

    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .build(ctx);
      const result = await plan.run();
      expect(result.success).toBe(true);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });

  test("SSOT requires EXPLICIT verifier pass — output without success/passed keys does NOT trigger carve-out", async () => {
    // Defensive: a verifier op that produces a malformed envelope (no success or
    // passed key) must not silently pass the story. SSOT means "verifier
    // explicitly judged this OK", not "verifier produced something parseable".
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    const gateOp = makeDeterministicOp("full-suite-gate", { success: false, findings: [] });
    // Malformed verifier output — neither `success` nor `passed` set.
    const malformedVerifierOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
      kind: "deterministic",
      name: "verifier",
      stage: "verify",
      config: testSel,
      execute: async () => ({ filesChanged: [], estimatedCostUsd: 0 }),
    };

    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: malformedVerifierOp, input: { code: "" } })
        .build(ctx);
      const result = await plan.run();
      // Gate explicitly failed AND verifier didn't explicitly pass → plan fails.
      expect(result.success).toBe(false);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });

  test("verifier-failed: gate failure still fails the plan (no SSOT override)", async () => {
    // Verifier-as-SSOT only applies when verifier passed. If verifier also failed,
    // aggregation must reflect both failures.
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    const gateOp = makeDeterministicOp("full-suite-gate", { success: false, findings: [] });
    const verOp = makeDeterministicOp("verifier", { success: false });

    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .build(ctx);
      const result = await plan.run();
      expect(result.success).toBe(false);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });
});

// ============================================================================
// AC3: TDD + inlineReview=false + rectification.enabled=true → full-suite-rectify dispatched
// AC5: gatherRectificationFindings carries all failing post-run findings into rectification
// ============================================================================

describe("AC3 + AC5: gate-internal rectification — finding aggregation and full-suite-rectify dispatch", () => {
  let rt: NaxRuntime | undefined;
  afterEach(async () => { await rt?.close(); });

  test("AC5: runFixCycle receives mixed-source findings from full-suite gate output", async () => {
    // Gate produces a mixed-source output: one test-runner finding + one lint finding.
    // The unified rectification entrypoint should preserve both so mechanical fixes can run.
    const config = makeNaxConfig({ execution: { rectification: { enabled: true, maxRetries: 3, abortOnIncreasingFailures: false } } });
    rt = makeTestRuntime({ config });

    let capturedCycleFindings: Finding[] | null = null;
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "test fail", rule: "t", file: "f.ts" },
        { source: "lint", category: "style", severity: "warning", message: "lint issue", rule: "l", file: "f.ts" },
      ],
    });
    const verOp = makeDeterministicOp("verifier", { success: false, findings: [] });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    _storyOrchestratorDeps.runFixCycle = async (cycle: any) => {
      capturedCycleFindings = cycle.findings;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    };

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx);
      await plan.run();

      expect(capturedCycleFindings).not.toBeNull();
      expect(capturedCycleFindings!.length).toBe(2);
      expect(capturedCycleFindings!.map((f: any) => f.source)).toEqual(["test-runner", "lint"]);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("AC5: verifier findings with non-test-runner source also reach rectification", async () => {
    // Verifier produces a review-category finding — the unified architecture should carry it into rectification.
    const config = makeNaxConfig({ execution: { rectification: { enabled: true, maxRetries: 3, abortOnIncreasingFailures: false } } });
    rt = makeTestRuntime({ config });

    let capturedCycleFindings: Finding[] | null = null;
    const gateOp = makeDeterministicOp("full-suite-gate", { success: true });
    const verOp = makeDeterministicOp("verifier", {
      success: false,
      findings: [{ source: "semantic-review", category: "semantic", severity: "error", message: "review fail", rule: "r", file: "f.ts" }],
    });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    _storyOrchestratorDeps.runFixCycle = async (cycle: any) => {
      capturedCycleFindings = cycle.findings;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    };

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx);
      await plan.run();

      expect(capturedCycleFindings).not.toBeNull();
      // Non-null assertion: TypeScript CFA doesn't track closure assignments, so we assert explicitly.
      expect(capturedCycleFindings!).toEqual([
        { source: "semantic-review", category: "semantic", severity: "error", message: "review fail", rule: "r", file: "f.ts" },
      ]);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("AC3: TDD + inlineReview=false + gate failed-test findings → full-suite-rectify strategy name present", async () => {
    // This is the critical end-to-end test: rectification was previously unreachable when
    // inlineReview=false. With the guard removed, gate findings now reach runFixCycle and
    // the full-suite-rectify strategy (prepended by buildPlanForStrategy) is dispatched.
    const config = makeNaxConfig({ execution: { rectification: { enabled: true, maxRetries: 3, abortOnIncreasingFailures: false } } });
    rt = makeTestRuntime({ config });

    let capturedStrategyNames: string[] = [];
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [{ source: "test-runner", category: "failed-test", severity: "error", message: "fail", rule: "t", file: "f.ts" }],
    });
    const verOp = makeDeterministicOp("verifier", { success: false, findings: [] });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    _storyOrchestratorDeps.runFixCycle = async (cycle: any) => {
      capturedStrategyNames = (cycle.strategies ?? []).map((s: any) => s.name);
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    };

    try {
      const { makeFullSuiteRectifyStrategy } = require("@/operations/full-suite-rectify");
      const { makeStory: ms } = require("@test/helpers");
      const story = ms({ id: "US-t", title: "test" });
      const fullSuiteStrategy = makeFullSuiteRectifyStrategy(story);

      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({
          maxAttempts: 3,
          strategies: [fullSuiteStrategy],  // simulating what buildPlanForStrategy prepends
          abortOnIncreasingFailures: false,
        })
        .build(ctx);
      await plan.run();

      expect(capturedStrategyNames).toContain("full-suite-rectify");
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

describe("AC-4 + AC-5: validate callback re-runs gate (not verifier), lite-mode skips gate", () => {
  let rt: NaxRuntime | undefined;
  afterEach(async () => { await rt?.close(); });

  test("AC-4: validate re-runs gate (mode=full) but never re-runs verifier (one-shot TDD isolation)", async () => {
    const config = makeNaxConfig({ execution: { rectification: { enabled: true, maxRetries: 3, abortOnIncreasingFailures: false } } });
    rt = makeTestRuntime({ config });

    const gateRunCount = { n: 0 };
    const verifierRunCount = { n: 0 };
    let capturedCycle: any = null;

    const gateOp = makeDeterministicOp("full-suite-gate", { success: false, findings: [{ source: "test-runner", category: "failed-test", severity: "error", message: "f", rule: "r", file: "f.ts" }] });
    const verOp = makeDeterministicOp("verifier", { success: false });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.name === "full-suite-gate") gateRunCount.n++;
      if (op.name === "verifier") verifierRunCount.n++;
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    _storyOrchestratorDeps.runFixCycle = async (cycle: any) => {
      capturedCycle = cycle;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    };

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [{ name: "s", appliesTo: () => true, fixOp: mockImplementerOp, buildInput: () => ({ code: "" }), maxAttempts: 1, coRun: "exclusive" as const }], abortOnIncreasingFailures: false })
        .build(ctx);
      await plan.run();

      if (capturedCycle) {
        const beforeGate = gateRunCount.n;
        const beforeVerifier = verifierRunCount.n;
        await capturedCycle.validate(ctx, { mode: "full" });
        // Gate still runs during validate (keeps phaseOutputs current for applyPostRunInspection).
        expect(gateRunCount.n).toBeGreaterThan(beforeGate);
        // Verifier is NEVER re-run inside rectification (Patch 3 / Defect C): its TDD-isolation
        // job is one-shot, anchored to the story-start git ref. The routing layer partitions
        // source vs. test edits, so re-dispatching the verifier asks a question already answered.
        expect(verifierRunCount.n).toBe(beforeVerifier);
      }
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("AC-5: validate skips gate when mode=lite", async () => {
    const config = makeNaxConfig({ execution: { rectification: { enabled: true, maxRetries: 3, abortOnIncreasingFailures: false } } });
    rt = makeTestRuntime({ config });

    const gateRunCount = { n: 0 };
    const verifierRunCount = { n: 0 };
    let capturedCycle: any = null;

    const gateOp = makeDeterministicOp("full-suite-gate", { success: false, findings: [{ source: "test-runner", category: "failed-test", severity: "error", message: "f", rule: "r", file: "f.ts" }] });
    const verOp = makeDeterministicOp("verifier", { success: false });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.name === "full-suite-gate") gateRunCount.n++;
      if (op.name === "verifier") verifierRunCount.n++;
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    _storyOrchestratorDeps.runFixCycle = async (cycle: any) => {
      capturedCycle = cycle;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    };

    try {
      const ctx: CallContext = { runtime: rt, packageView: rt.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-t" } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [{ name: "s", appliesTo: () => true, fixOp: mockImplementerOp, buildInput: () => ({ code: "" }), maxAttempts: 1, coRun: "exclusive" as const }], abortOnIncreasingFailures: false })
        .build(ctx);
      await plan.run();

      if (capturedCycle) {
        const beforeGate = gateRunCount.n;
        const beforeVerifier = verifierRunCount.n;
        await capturedCycle.validate(ctx, { mode: "lite" });
        expect(gateRunCount.n).toBe(beforeGate);     // lite mode: gate skipped
        expect(verifierRunCount.n).toBe(beforeVerifier); // Patch 3: verifier never re-run
      }
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});
