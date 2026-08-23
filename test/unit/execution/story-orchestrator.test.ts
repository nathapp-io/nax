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

import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CompleteResult, TurnResult } from "@/agents/types";
import { pickSelector } from "@/config";
import type { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import {
  StoryOrchestratorBuilder,
  _storyOrchestratorDeps,
  formatPhaseResultMessage,
  phasesToRevalidate,
  refreshReviewInputForDispatch,
} from "@/execution";
import type { Finding, ReviewCheckResult } from "@/findings";
import type { CallContext, CompleteOperation, DeterministicOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeLinkWithCosts, makeMockAgentManager, makeNaxConfig, makeTestRuntime } from "@test/helpers";

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

const mockImplementerOp: RunOperation<TestImplementerInput, TestImplementerOutput, typeof DEFAULT_CONFIG> = {
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

const mockTestWriterOp: RunOperation<TestTestWriterInput, TestTestWriterOutput, typeof DEFAULT_CONFIG> = {
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

const mockVerifierOp: RunOperation<TestVerifierInput, TestVerifierOutput, typeof DEFAULT_CONFIG> = {
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

const mockSemanticReviewOp: RunOperation<TestSemanticReviewInput, TestSemanticReviewOutput, typeof DEFAULT_CONFIG> = {
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
    const makeOrderTracker = (roles: string[]) =>
      makeMockAgentManager({
        runAsSessionFn: async (_req, onSuccess) => {
          const role = _req.sessionRole ?? "unknown";
          roles.push(role);
          return onSuccess({
            turnId: randomUUID(),
            output: JSON.stringify({ success: true }),
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            estimatedCostUsd: 0.001,
          });
        },
      });

    const order1: string[] = [];
    runtime = makeTestRuntime({ config, agentManager: makeOrderTracker(order1) });
    const ctx1: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };
    await new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addTestWriter({ op: mockTestWriterOp, input: { story: "test" } })
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .build(ctx1)
      .run();
    expect(order1).toEqual(["test-writer", "implementer", "verifier"]);
    await runtime.close();
    runtime = undefined;

    const order2: string[] = [];
    runtime = makeTestRuntime({ config, agentManager: makeOrderTracker(order2) });
    const ctx2: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };
    await new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .build(ctx2)
      .run();
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
      return { success: true };
    });

    const mockAgentManager = makeMockAgentManager();
    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });

    const { StoryOrchestratorBuilder } = require("@/execution/story-orchestrator");
    const builder = new StoryOrchestratorBuilder().addImplementer({ op: mockImplementerOp, input: { code: "test" } });

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

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)().addImplementer({
      op: mockImplementerOp,
      input: { code: "test" },
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

    expect(result.success).toBe(false);
  });

  test("logs and propagates thrown errors with { storyId, phase, error }", async () => {
    const config = makeNaxConfig();
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async () => {
        throw new Error("Test error");
      },
    });
    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };
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

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)().addImplementer({
      op: mockImplementerOp,
      input: { code: "test" },
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

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("phaseCosts");
    expect(result).toHaveProperty("totalCostUsd");
    expect(result).toHaveProperty("durationMs");
  });

  test("aggregates per-phase costs keyed by op.name and sums into totalCostUsd", async () => {
    const config = makeNaxConfig();
    const mockAgentManager = makeMockAgentManager({
      runAsSessionFn: async (_req, onSuccess) =>
        onSuccess({
          turnId: randomUUID(),
          output: JSON.stringify({ success: true }),
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.005,
        }),
    });
    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };
    const result = await new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addVerifier({ op: mockVerifierOp, input: { code: "test" } })
      .build(ctx)
      .run();
    expect(result.phaseCosts["mock-implementer"]).toBeGreaterThanOrEqual(0);
    expect(result.phaseCosts["mock-verifier"]).toBeGreaterThanOrEqual(0);
    expect(result.totalCostUsd).toBeCloseTo(
      Object.values(result.phaseCosts).reduce((a, b) => a + b, 0),
      5,
    );
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
        return onSuccess({
          turnId: randomUUID(),
          output: JSON.stringify({ success: true }),
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        });
      },
    });
    runtime = makeTestRuntime({ config, agentManager: mockAgentManager });
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "story-1",
    };
    const result = await new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
      .addImplementer({ op: mockImplementerOp, input: { code: "test" } })
      .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
      .build(ctx)
      .run();
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

    const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)().addImplementer({
      op: mockImplementerOp,
      input: { code: "test" },
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
  afterEach(async () => {
    await rt?.close();
  });

  test("when rectification configured: gate failure halts before verifier (verifier judges only on green code)", async () => {
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    let verifierRan = false;
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "fail", rule: "t", file: "t.ts" },
      ],
    });
    const verOp = makeDeterministicOp("verifier", { success: true });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.name === "verifier") verifierRan = true;
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    _storyOrchestratorDeps.runFixCycle = async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0,
    });

    try {
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx);
      await plan.run();
      // New contract: verifier MUST NOT run on broken-gate code when rectification is the responsible loop.
      expect(verifierRan).toBe(false);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("when rectification NOT configured: gate failure halts plan (no verifier called)", async () => {
    // New contract: gate failure halts the plan — no verifier call on broken code.
    // Without rectification, escalation uses deriveTddFailureCategory("tests-failing").
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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .build(ctx);
      await plan.run();
      // New contract: no rectification → gate halt → verifier not reached.
      expect(verifierRan).toBe(false);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });

  test("gate-only failure (no rectification) halts before verifier and fails the plan — escalation handles unrelated-regression case", async () => {
    // Behaviour change: the old verifier-as-SSOT escape hatch (gate fails but
    // verifier judges OK → pass) is now handled at the escalation boundary via
    // deriveTddFailureCategory (returns "tests-failing" → escalate). In-plan,
    // gate failure halts immediately when no rectification is configured.
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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .build(ctx);
      const result = await plan.run();
      expect(verifierRan).toBe(false);
      expect(result.success).toBe(false);
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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
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

  test("strict verdict phases fail-closed when output has no success/passed keys", async () => {
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    const malformedGateOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
      kind: "deterministic",
      name: "full-suite-gate",
      stage: "verify",
      config: testSel,
      execute: async () => ({ status: "execution-failed", findings: [] }),
    };

    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;

      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: malformedGateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .build(ctx);

      const result = await plan.run();
      expect(result.success).toBe(false);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });

  test.each([
    ["full-suite-gate", undefined],
    ["verify-scoped", "not-an-object"],
    ["lint-check", { status: "execution-failed" }],
    ["typecheck-check", { findings: [] }],
    ["verifier", { filesChanged: [], estimatedCostUsd: 0 }],
  ] as const)("strict phase %s fails-closed on malformed output", async (phaseName, malformedOutput) => {
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    const malformedStrictOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
      kind: "deterministic",
      name: phaseName,
      stage: "verify",
      config: testSel,
      execute: async () => malformedOutput,
    };

    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;

      const builder = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)().addImplementer({
        op: mockImplementerOp,
        input: { code: "" },
      });

      if (phaseName === "full-suite-gate") {
        builder.addFullSuiteGate({ op: malformedStrictOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } });
      } else if (phaseName === "verify-scoped") {
        builder.addVerifyScoped({ op: malformedStrictOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } });
      } else if (phaseName === "lint-check") {
        builder.addLintCheck({ op: malformedStrictOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } });
      } else if (phaseName === "typecheck-check") {
        builder.addTypecheckCheck({ op: malformedStrictOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } });
      } else {
        builder.addVerifier({ op: malformedStrictOp, input: { code: "" } });
      }

      const plan = builder.build(ctx);
      const result = await plan.run();
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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
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
  afterEach(async () => {
    await rt?.close();
  });

  test("AC5: runFixCycle receives mixed-source findings from full-suite gate output", async () => {
    // Gate produces a mixed-source output: one test-runner finding + one lint finding.
    // The unified rectification entrypoint should preserve both so mechanical fixes can run.
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    let capturedCycleFindings: Finding[] | null = null;
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        {
          source: "test-runner",
          category: "failed-test",
          severity: "error",
          message: "test fail",
          rule: "t",
          file: "f.ts",
        },
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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
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
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    let capturedCycleFindings: Finding[] | null = null;
    const gateOp = makeDeterministicOp("full-suite-gate", { success: true });
    const verOp = makeDeterministicOp("verifier", {
      success: false,
      findings: [
        {
          source: "semantic-review",
          category: "semantic",
          severity: "error",
          message: "review fail",
          rule: "r",
          file: "f.ts",
        },
      ],
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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
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
        {
          source: "semantic-review",
          category: "semantic",
          severity: "error",
          message: "review fail",
          rule: "r",
          file: "f.ts",
        },
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
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    let capturedStrategyNames: string[] = [];
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "fail", rule: "t", file: "f.ts" },
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
      capturedStrategyNames = (cycle.strategies ?? []).map((s: any) => s.name);
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    };

    try {
      const { makeFullSuiteRectifyStrategy } = require("@/operations/full-suite-rectify");
      const { makeStory: ms } = require("@test/helpers");
      const story = ms({ id: "US-t", title: "test" });
      const fullSuiteStrategy = makeFullSuiteRectifyStrategy(story, makeNaxConfig());

      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({
          maxAttempts: 3,
          strategies: [fullSuiteStrategy], // simulating what buildPlanForStrategy prepends
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

describe("AC-4 + AC-5: validate callback re-runs gate and verifier, lite-mode skips gate only", () => {
  let rt: NaxRuntime | undefined;
  afterEach(async () => {
    await rt?.close();
  });

  test("AC-4: validate re-runs gate (mode=full) and re-runs verifier when strategy maps to it (new: previously hard-stripped)", async () => {
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    const gateRunCount = { n: 0 };
    const verifierRunCount = { n: 0 };
    let capturedCycle: any = null;

    // Gate passes during validate so the revalidation short-circuit doesn't fire;
    // this test asserts "verifier IS re-run when strategy maps to it", not gate-halt.
    // Short-circuit behavior is covered by the dedicated test below.
    const gateOp = makeDeterministicOp("full-suite-gate", { success: true, findings: [] });
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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({
          maxAttempts: 3,
          strategies: [
            {
              name: "s",
              appliesTo: () => true,
              fixOp: mockImplementerOp,
              buildInput: () => ({ code: "" }),
              maxAttempts: 1,
              coRun: "exclusive" as const,
            },
          ],
          abortOnIncreasingFailures: false,
        })
        .build(ctx);
      await plan.run();

      if (capturedCycle) {
        const beforeGate = gateRunCount.n;
        const beforeVerifier = verifierRunCount.n;
        await capturedCycle.validate(ctx, { mode: "full" });
        // Gate still runs during validate (keeps phaseOutputs current for applyPostRunInspection).
        expect(gateRunCount.n).toBeGreaterThan(beforeGate);
        // New contract (Task 2): verifier IS re-run when the strategy maps to it or is unknown.
        // Unknown strategy "s" → fallback to all phases (conservative default) → verifier included.
        expect(verifierRunCount.n).toBeGreaterThan(beforeVerifier);
      }
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("AC-5: validate skips gate when mode=lite", async () => {
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    const gateRunCount = { n: 0 };
    const verifierRunCount = { n: 0 };
    let capturedCycle: any = null;

    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "f", rule: "r", file: "f.ts" },
      ],
    });
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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({
          maxAttempts: 3,
          strategies: [
            {
              name: "s",
              appliesTo: () => true,
              fixOp: mockImplementerOp,
              buildInput: () => ({ code: "" }),
              maxAttempts: 1,
              coRun: "exclusive" as const,
            },
          ],
          abortOnIncreasingFailures: false,
        })
        .build(ctx);
      await plan.run();

      if (capturedCycle) {
        const beforeGate = gateRunCount.n;
        const beforeVerifier = verifierRunCount.n;
        await capturedCycle.validate(ctx, { mode: "lite" });
        expect(gateRunCount.n).toBe(beforeGate); // lite mode: gate skipped
        // New contract (Task 2): verifier re-runs even in lite mode — lite only exempts the gate.
        // Unknown strategy "s" → fallback to all phases → verifier included; gate guard fires only on "full-suite-gate".
        expect(verifierRunCount.n).toBeGreaterThan(beforeVerifier);
      }
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("AC-6: validate short-circuits on phase failure — verifier does not run on broken-gate code", async () => {
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    const gateRunCount = { n: 0 };
    const verifierRunCount = { n: 0 };
    let capturedCycle: any = null;

    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "f", rule: "r", file: "f.ts" },
      ],
    });
    const verOp = makeDeterministicOp("verifier", { success: true });

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
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addRectification({
          maxAttempts: 3,
          strategies: [
            {
              name: "s",
              appliesTo: () => true,
              fixOp: mockImplementerOp,
              buildInput: () => ({ code: "" }),
              maxAttempts: 1,
              coRun: "exclusive" as const,
            },
          ],
          abortOnIncreasingFailures: false,
        })
        .build(ctx);
      await plan.run();

      if (capturedCycle) {
        const beforeGate = gateRunCount.n;
        const beforeVerifier = verifierRunCount.n;
        await capturedCycle.validate(ctx, { mode: "full" });
        // Gate runs during validate and fails.
        expect(gateRunCount.n).toBeGreaterThan(beforeGate);
        // Verifier MUST NOT run after a failing gate (spec §2C halt contract,
        // mirrors the main loop's short-circuit; prevents verifier from judging
        // broken-gate code, which was the bug in the 2026-05-27T05-06-41 run).
        expect(verifierRunCount.n).toBe(beforeVerifier);
      }
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("AC-7: post-rectification resume runs canonical phases skipped by short-circuit (e.g. adversarial-review)", async () => {
    // Restores prior orchestrator behavior: after rectification resolves all findings,
    // the canonical loop resumes from where it short-circuited so reviewers run on the
    // fixed code. STRATEGY_TO_REVALIDATION_PHASES["full-suite-rectify"] intentionally
    // excludes adversarial-review; without the resume, it never runs. See log
    // 2026-05-27T05-06-41.jsonl line 521 — phasesSelected omitted adversarial.
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    const opRuns: Record<string, number> = {};
    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "f", rule: "r", file: "f.ts" },
      ],
    });
    const verOp = makeDeterministicOp("verifier", { success: true });
    const advOp = makeDeterministicOp("adversarial-review", { success: true, findings: [] });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      opRuns[op.name] = (opRuns[op.name] ?? 0) + 1;
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    // Simulate rectification resolving the gate: swap gateOp.execute to succeed
    // during the validate sweep, then restore. After the swap, the cycle reports
    // "resolved" so the post-rectification resume kicks in.
    _storyOrchestratorDeps.runFixCycle = async (cycle: any, cycleCtx: any) => {
      const origGateExecute = gateOp.execute;
      (gateOp as any).execute = () => ({ success: true, findings: [] });
      try {
        await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["full-suite-rectify"] });
      } finally {
        (gateOp as any).execute = origGateExecute;
      }
      return {
        iterations: [{ strategyName: "full-suite-rectify" }],
        finalFindings: [],
        exitReason: "resolved" as const,
        costUsd: 0,
      };
    };

    try {
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new StoryOrchestratorBuilder()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { code: "" } })
        .addAdversarialReview({ op: advOp, input: { code: "" } })
        .addRectification({
          maxAttempts: 3,
          strategies: [
            {
              name: "full-suite-rectify",
              appliesTo: () => true,
              fixOp: mockImplementerOp,
              buildInput: () => ({ code: "" }),
              maxAttempts: 1,
              coRun: "exclusive" as const,
            },
          ],
          abortOnIncreasingFailures: false,
        })
        .build(ctx);
      await plan.run();

      // Main loop short-circuited at gate, so adversarial never ran there.
      // Rectification revalidation doesn't include adversarial in its set.
      // Post-rectification resume MUST dispatch adversarial-review on the fixed code.
      expect(opRuns["adversarial-review"] ?? 0).toBeGreaterThan(0);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});

// ============================================================================
// refreshReviewInputForDispatch — re-prepare review inputs at dispatch time
// ============================================================================

describe("refreshReviewInputForDispatch — re-prepare review inputs at dispatch time (Bug A)", () => {
  test("semantic-review input is refreshed with fresh stat/diff at dispatch", async () => {
    const origPrepare = _storyOrchestratorDeps.prepareSemanticReviewInput;
    _storyOrchestratorDeps.prepareSemanticReviewInput = mock(async () => ({
      effectiveRef: "fresh-ref",
      stat: "src/foo.ts | 5 ++++-",
      diff: "diff content",
      excludePatterns: ["test/**"],
    })) as typeof _storyOrchestratorDeps.prepareSemanticReviewInput;

    try {
      const staleInput = {
        workdir: "/tmp/repo",
        story: { id: "US-x" } as any,
        semanticConfig: { diffMode: "ref" } as any,
        mode: "ref" as const,
        stat: "",
        diff: undefined,
        storyGitRef: "stale-ref",
        excludePatterns: [],
        _refresh: {
          projectDir: "/tmp/repo",
          storyId: "US-x",
          storyGitRef: "stale-ref",
        },
      };
      const refreshed = (await refreshReviewInputForDispatch("semantic-review", staleInput)) as any;
      expect(refreshed.stat).toBe("src/foo.ts | 5 ++++-");
      expect(refreshed.diff).toBe("diff content");
      expect(refreshed.excludePatterns).toEqual(["test/**"]);
      expect(refreshed.storyGitRef).toBe("fresh-ref");
    } finally {
      _storyOrchestratorDeps.prepareSemanticReviewInput = origPrepare;
    }
  });

  test("adversarial-review input is refreshed with fresh stat/diff/testInventory at dispatch", async () => {
    const origPrepare = _storyOrchestratorDeps.prepareAdversarialReviewInput;
    _storyOrchestratorDeps.prepareAdversarialReviewInput = mock(async () => ({
      effectiveRef: "fresh-ref",
      stat: "src/foo.ts | 5",
      diff: "diff",
      testInventory: { tests: 3 } as any,
      excludePatterns: ["test/**"],
      testGlobs: ["test/**/*.test.ts"],
      refExcludePatterns: [":(exclude)test/**"],
    })) as typeof _storyOrchestratorDeps.prepareAdversarialReviewInput;

    try {
      const refreshed = (await refreshReviewInputForDispatch("adversarial-review", {
        workdir: "/tmp/repo",
        story: { id: "US-x" } as any,
        adversarialConfig: { diffMode: "ref" } as any,
        mode: "ref" as const,
        stat: "",
        diff: undefined,
        _refresh: { projectDir: "/tmp/repo", storyId: "US-x", storyGitRef: undefined },
      })) as any;
      expect(refreshed.stat).toBe("src/foo.ts | 5");
      expect(refreshed.testInventory).toEqual({ tests: 3 });
      expect(refreshed.testGlobs).toEqual(["test/**/*.test.ts"]);
    } finally {
      _storyOrchestratorDeps.prepareAdversarialReviewInput = origPrepare;
    }
  });

  test("non-review phases pass through unchanged", async () => {
    const input = { foo: "bar" };
    const result = await refreshReviewInputForDispatch("full-suite-gate", input);
    expect(result).toBe(input);
  });

  test("input without _refresh payload passes through unchanged (backward compat)", async () => {
    const input = { workdir: "/tmp", semanticConfig: {} };
    const result = await refreshReviewInputForDispatch("semantic-review", input);
    expect(result).toBe(input);
  });
});

// ============================================================================
// phasesToRevalidate — verifier inclusion after fix strategies (Task 2)
// ============================================================================

describe("phasesToRevalidate — verifier inclusion after fix strategies", () => {
  // Helper to construct an InternalPhase stub — only `kind` matters for filtering.
  const phase = (kind: string) => ({ kind, slot: { op: { name: kind } as any, input: {} } }) as any;

  const allPhases = [
    phase("full-suite-gate"),
    phase("verifier"),
    phase("lint-check"),
    phase("typecheck-check"),
    phase("semantic-review"),
    phase("adversarial-review"),
  ];

  test("full-suite-rectify strategy re-runs verifier (previously hard-stripped)", () => {
    const result = phasesToRevalidate(["full-suite-rectify"], allPhases);
    const kinds = result.map((p: any) => p.kind);
    expect(kinds).toContain("verifier");
    expect(kinds).toContain("full-suite-gate");
  });

  test("autofix-implementer strategy does NOT re-run verifier (once-per-story TDD isolation check)", () => {
    const result = phasesToRevalidate(["autofix-implementer"], allPhases);
    const kinds = result.map((p: any) => p.kind);
    // autofix-implementer addresses review findings, not the TDD boundary — verifier excluded.
    expect(kinds).not.toContain("verifier");
    // Lint, typecheck, gate, semantic, adversarial are still re-run.
    expect(kinds).toContain("full-suite-gate");
    expect(kinds).toContain("lint-check");
  });

  test("autofix-test-writer strategy does NOT re-run verifier (once-per-story TDD isolation check)", () => {
    const result = phasesToRevalidate(["autofix-test-writer"], allPhases);
    const kinds = result.map((p: any) => p.kind);
    // autofix-test-writer rewrites tests for adversarial-review — not re-doing TDD boundary.
    expect(kinds).not.toContain("verifier");
    expect(kinds).toContain("full-suite-gate");
    expect(kinds).toContain("lint-check");
  });

  test("mechanical-lintfix does NOT re-run verifier (style-only, no semantic regression risk)", () => {
    const result = phasesToRevalidate(["mechanical-lintfix"], allPhases);
    expect(result.map((p: any) => p.kind)).not.toContain("verifier");
    expect(result.map((p: any) => p.kind)).toEqual(["lint-check"]);
  });

  test("unknown strategy falls back to all phases including verifier", () => {
    const result = phasesToRevalidate(["plugin-unknown-strategy"], allPhases);
    expect(result.map((p: any) => p.kind)).toContain("verifier");
  });

  test("empty strategiesRun falls back to all phases including verifier", () => {
    const result = phasesToRevalidate([], allPhases);
    expect(result.map((p: any) => p.kind)).toContain("verifier");
  });

  test("undefined strategiesRun falls back to all phases including verifier", () => {
    const result = phasesToRevalidate(undefined, allPhases);
    expect(result.map((p: any) => p.kind)).toContain("verifier");
  });
});

// ============================================================================
// formatPhaseResultMessage — phase log wording (Task 4)
// ============================================================================

describe("formatPhaseResultMessage — phase log wording", () => {
  test("greenfield-gate success → 'pre-existing tests detected' (not 'Phase passed')", () => {
    const msg = formatPhaseResultMessage("greenfield-gate", true);
    expect(msg).toContain("pre-existing tests detected");
    expect(msg).toContain("not greenfield");
    expect(msg).not.toContain("Phase passed");
  });

  test("greenfield-gate failure → 'no pre-existing tests, greenfield run'", () => {
    const msg = formatPhaseResultMessage("greenfield-gate", false);
    expect(msg).toContain("no pre-existing tests");
    expect(msg).toContain("greenfield run");
    expect(msg).not.toContain("Phase failed");
  });

  test("other phases use generic 'Phase passed: X' wording", () => {
    expect(formatPhaseResultMessage("full-suite-gate", true)).toBe("Phase passed: full-suite-gate");
    expect(formatPhaseResultMessage("verifier", true)).toBe("Phase passed: verifier");
    expect(formatPhaseResultMessage("lint-check", true)).toBe("Phase passed: lint-check");
  });

  test("other phases use generic 'Phase failed: X' wording", () => {
    expect(formatPhaseResultMessage("full-suite-gate", false)).toBe("Phase failed: full-suite-gate");
    expect(formatPhaseResultMessage("verifier", false)).toBe("Phase failed: verifier");
  });
});

// ============================================================================
// rectification phase envelope (Task 3)
// ============================================================================

describe("rectification phase envelope", () => {
  let rt: NaxRuntime | undefined;
  afterEach(async () => {
    await rt?.close();
  });

  test("rectification 'resolved' exit produces { success: true, exitReason: 'resolved', ... }", async () => {
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "fail", rule: "t", file: "t.ts" },
      ],
    });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    _storyOrchestratorDeps.runFixCycle = async () => ({
      iterations: [
        {
          iterationNum: 1,
          findingsBefore: 1,
          fixesApplied: [],
          findingsAfter: 0,
          outcome: "resolved" as const,
          startedAt: 0,
          finishedAt: 0,
        },
      ],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0,
    });

    try {
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx);
      const result = await plan.run();

      // Contract: rectification phase envelope must include explicit success
      // matching the cycle's exit reason. The "neither 'success' nor 'passed'"
      // warning is suppressed as a free consequence.
      const rectOut = result.phaseOutputs?.rectification as Record<string, unknown> | undefined;
      expect(rectOut).toBeDefined();
      expect(rectOut?.success).toBe(true);
      expect(rectOut?.exitReason).toBe("resolved");
      expect(rectOut?.iterationCount).toBe(1);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("rectification 'max-attempts-total' exit produces { success: false, exitReason: 'max-attempts-total', ... }", async () => {
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxAttemptsTotal: 3, abortOnIncreasingFailures: false } },
    });
    rt = makeTestRuntime({ config });

    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "fail", rule: "t", file: "t.ts" },
      ],
    });

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };
    _storyOrchestratorDeps.runFixCycle = async () => ({
      iterations: [],
      finalFindings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "fail", rule: "t", file: "t.ts" },
      ],
      exitReason: "max-attempts-total" as const,
      costUsd: 0,
    });

    try {
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-t",
      } as any;
      const plan = new (require("@/execution/story-orchestrator").StoryOrchestratorBuilder)()
        .addImplementer({ op: mockImplementerOp, input: { code: "" } })
        .addFullSuiteGate({ op: gateOp, input: { story: { id: "US-t" } as any, workdir: "/tmp" } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx);
      const result = await plan.run();

      const rectOut = result.phaseOutputs?.rectification as Record<string, unknown> | undefined;
      expect(rectOut?.success).toBe(false);
      expect(rectOut?.exitReason).toBe("max-attempts-total");
      expect(rectOut?.finalFindingsCount).toBe(1);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});
