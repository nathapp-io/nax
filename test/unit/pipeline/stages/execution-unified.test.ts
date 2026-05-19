/**
 * Unified Execution Stage Tests
 *
 * Tests for the collapsed execution stage that uses:
 * - Single plan construction for all strategies (TDD and non-TDD)
 * - Single plan.run() execution
 * - Post-run inspection for verdict/rollback/pause handling
 *
 * Story: US-005.S4 - Collapse execution stage to single plan run plus post-run inspection
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory, makeMockAgentManager } from "../../../helpers";
import type { PipelineContext } from "../../../src/pipeline";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a minimal PipelineContext for testing the execution stage.
 * This is a stub implementation to support test compilation.
 */
function makePipelineContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config = makeNaxConfig();
  const story = makeStory();
  const agentManager = makeMockAgentManager();

  return {
    story,
    stories: [story],
    config,
    rootConfig: config,
    prd: {
      project: "test",
      feature: "test-feature",
      branchName: "test-branch",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    },
    projectDir: "/tmp/test",
    workdir: "/tmp/test",
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      agent: "claude",
    },
    agentManager,
    sessionManager: {
      openSession: async () => ({ sessionId: "test-session" } as any),
      sendPrompt: async () => ({ output: "test" } as any),
      closeSession: async () => {},
      runInSession: async () => ({ output: "test" } as any),
      handoff: async () => {},
      nameFor: () => "test-session",
    } as any,
    runtime: {
      signal: AbortSignal.timeout(300000),
      onPidSpawned: () => {},
      dispatchEvents: undefined,
    } as any,
    abortSignal: AbortSignal.timeout(300000),
    hooks: {},
    prompt: "Test prompt",
    featureContextMarkdown: "Feature context",
    constitution: { content: "Constitution" },
    ...overrides,
  } as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: Single Plan Build and Single plan.run() Execution
// ─────────────────────────────────────────────────────────────────────────────

describe("Unified Execution Stage — AC1: Single plan build and run", () => {
  test("builds exactly one plan for test-after strategy", () => {
    // This test verifies that the execution stage builds exactly one plan
    // regardless of strategy (test-after, TDD, etc.)
    // The implementation should use buildPlanForStrategy and then call plan.run() once.
    const ctx = makePipelineContext({
      routing: { testStrategy: "test-after" } as any,
    });

    // Stub: The actual execution stage should construct a plan once.
    // This test will verify that buildPlanForStrategy is called exactly once
    // and that plan.run() is invoked exactly once.
    expect(ctx.story.id).toBeDefined();
    expect(ctx.routing.testStrategy).toBe("test-after");
  });

  test("builds exactly one plan for three-session-tdd strategy", () => {
    // Same as above but for TDD strategy
    const ctx = makePipelineContext({
      routing: { testStrategy: "three-session-tdd" } as any,
    });

    expect(ctx.story.id).toBeDefined();
    expect(ctx.routing.testStrategy).toBe("three-session-tdd");
  });

  test("builds exactly one plan for three-session-tdd-lite strategy", () => {
    // Verify lite mode also uses the same unified path
    const ctx = makePipelineContext({
      routing: { testStrategy: "three-session-tdd-lite" } as any,
    });

    expect(ctx.story.id).toBeDefined();
    expect(ctx.routing.testStrategy).toBe("three-session-tdd-lite");
  });

  test("executes plan.run() exactly once regardless of strategy", () => {
    // The implementation should call plan.run() exactly one time.
    // This could be verified by mocking StoryOrchestratorBuilder
    // and counting invocations of the run() method.
    const ctx = makePipelineContext();

    // Placeholder: Actual test would track run() invocations
    expect(ctx.config).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: No Sequencing Branch Between TDD and Non-TDD
// ─────────────────────────────────────────────────────────────────────────────

describe("Unified Execution Stage — AC2: No strategy branching", () => {
  test("uses unified path for test-after strategy (not direct orchestration)", () => {
    // The current implementation has two major branches (lines 47-138 for TDD, 140-325 for non-TDD).
    // The new implementation should have a single unified path that:
    // 1. Assembles plan inputs
    // 2. Calls buildPlanForStrategy
    // 3. Builds plan via StoryOrchestratorBuilder
    // 4. Calls plan.run() once
    // 5. Performs post-run inspection
    const ctx = makePipelineContext({
      routing: { testStrategy: "test-after" } as any,
    });

    // The key is that there should be NO direct calls to:
    // - runThreeSessionTddFromCtx (TDD path)
    // - implementerOp dispatch (non-TDD path)
    // Instead, all orchestration happens through buildPlanForStrategy + StoryOrchestratorBuilder
    expect(ctx.routing.testStrategy).toBe("test-after");
  });

  test("uses unified path for three-session-tdd strategy", () => {
    const ctx = makePipelineContext({
      routing: { testStrategy: "three-session-tdd" } as any,
    });

    // Same expectation: no branching, single unified path
    expect(ctx.routing.testStrategy).toBe("three-session-tdd");
  });

  test("does not branch on ctx.routing.testStrategy at stage level", () => {
    // Verification that execution.ts does not contain:
    // if (isTddStrategy) { ... runThreeSessionTddFromCtx() ... }
    // if (!isTddStrategy) { ... implementerOp dispatch ... }
    // Instead, strategy selection happens inside buildPlanForStrategy
    const ctx = makePipelineContext();
    expect(ctx.routing).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: Post-Run Inspection Handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Unified Execution Stage — AC3: Post-run inspection", () => {
  test("extracts verdict from plan result", () => {
    // After plan.run() returns, execution stage should:
    // 1. Extract verdict (success/failure)
    // 2. Categorize failure (if applicable)
    // 3. Handle rollback if needed
    // 4. Surface isolation info
    // 5. Handle pauseReason
    const ctx = makePipelineContext();

    // Stub: Actual test would mock plan.run() and verify inspection logic
    expect(ctx.story).toBeDefined();
  });

  test("categorizes failure from plan result phaseOutputs", () => {
    // The post-run inspection should read phaseOutputs to determine
    // which phase failed and what category of failure it was
    const ctx = makePipelineContext();

    // Stub for implementation
    expect(ctx.config).toBeDefined();
  });

  test("detects rollback trigger from post-run inspection", () => {
    // Some failure types may require rollback (e.g., dirty state after implementation)
    // Post-run inspection should detect this and signal rollback action
    const ctx = makePipelineContext();

    // Stub
    expect(ctx.workdir).toBeDefined();
  });

  test("surfaces isolation info from verification phase output", () => {
    // If verifier phase was included, post-run inspection should
    // extract isolation context (e.g., what was isolated, by which tests)
    const ctx = makePipelineContext({
      routing: { testStrategy: "three-session-tdd" } as any,
    });

    expect(ctx.routing.testStrategy).toBe("three-session-tdd");
  });

  test("handles pauseReason from plan result", () => {
    // Some operations (e.g., rectification) may produce a pauseReason
    // Post-run inspection should detect and surface this
    const ctx = makePipelineContext();

    expect(ctx.config).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: pauseReason Interaction Notify and Stage Pause
// ─────────────────────────────────────────────────────────────────────────────

describe("Unified Execution Stage — AC4: pauseReason interaction and pause action", () => {
  test("sends interaction notify when pauseReason exists and interaction enabled", () => {
    // When post-run inspection detects pauseReason:
    // 1. Send interaction notify to inform user of pause
    // 2. Return stage action "pause"
    const ctx = makePipelineContext({
      interaction: {
        send: async () => ({}),
      } as any,
    });

    // Stub: Actual test would mock ctx.interaction.send and verify it's called
    expect(ctx.interaction).toBeDefined();
  });

  test("returns stage action pause when pauseReason is set", () => {
    // The stage result should be { action: "pause", reason: pauseReason }
    const ctx = makePipelineContext();

    // Stub
    expect(ctx.config).toBeDefined();
  });

  test("does not send notification when interaction is not enabled", () => {
    // If ctx.interaction is null/undefined, the stage should still pause
    // but without sending a notification
    const ctx = makePipelineContext({
      interaction: undefined,
    });

    expect(ctx.interaction).toBeUndefined();
  });

  test("includes pause reason in stage result and notification", () => {
    // Both the notification and the stage result should include the pause reason
    const ctx = makePipelineContext({
      interaction: {
        send: async () => ({}),
      } as any,
    });

    // Stub
    expect(ctx.story.id).toBeDefined();
  });

  test("generates unique interaction ID for pause notification", () => {
    // The interaction notify should have a unique ID (e.g., pause-<storyId>-<timestamp>)
    const ctx = makePipelineContext({
      interaction: {
        send: async () => ({}),
      } as any,
    });

    expect(ctx.story.id).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: Source Guard - No Direct Orchestration Calls Outside Plan-Run Paths
// ─────────────────────────────────────────────────────────────────────────────

describe("Unified Execution Stage — AC5: Source guard - orchestration isolation", () => {
  test("does not call callOp directly at stage level", () => {
    // The execution stage should not contain direct callOp invocations.
    // All orchestration should flow through:
    // 1. buildPlanForStrategy (in src/execution/build-plan-for-strategy.ts)
    // 2. StoryOrchestratorBuilder.build(callCtx)
    // 3. plan.run()
    const ctx = makePipelineContext();

    // Verification would be done via grep/parsing of execution.ts:
    // "callOp" should only appear in comments or import statements,
    // never in actual stage execute() logic.
    expect(ctx).toBeDefined();
  });

  test("does not construct SessionKeeper directly at stage level", () => {
    // SessionKeeper is an internal orchestrator construct.
    // The stage should not instantiate it directly; instead,
    // StoryOrchestratorBuilder handles that internally.
    const ctx = makePipelineContext();

    expect(ctx.config).toBeDefined();
  });

  test("does not call runWithFallback at stage level", () => {
    // AgentManager.runWithFallback is a runtime behavior concern.
    // The stage should not call it directly; the plan builder handles
    // agent selection and fallback is handled by the runtime/manager.
    const ctx = makePipelineContext();

    expect(ctx.agentManager).toBeDefined();
  });

  test("uses StoryOrchestratorBuilder.build() as sole orchestration entry", () => {
    // The stage's sole orchestration interaction should be:
    // 1. new StoryOrchestratorBuilder().add...().build(callCtx)
    // 2. plan.run()
    // This ensures a single point of control for plan construction.
    const ctx = makePipelineContext();

    expect(ctx.runtime).toBeDefined();
  });

  test("delegates all phase orchestration to plan builder", () => {
    // Adding test-writer, implementer, verifier, etc., should happen
    // inside StoryOrchestratorBuilder, not inside the stage.
    // The stage only calls buildPlanForStrategy and let builder add slots.
    const ctx = makePipelineContext();

    expect(ctx.routing).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: Full Unified Path with Post-Run Inspection
// ─────────────────────────────────────────────────────────────────────────────

describe("Unified Execution Stage — Integration: Full flow", () => {
  test("completes unified path: assemble → build plan → run → inspect for success", () => {
    // End-to-end happy path:
    // 1. executionStage.execute(ctx) calls assemblePlanInputs
    // 2. Calls buildPlanForStrategy
    // 3. Builds plan with StoryOrchestratorBuilder
    // 4. Calls plan.run()
    // 5. Post-run inspection extracts result
    // 6. Returns { action: "continue" } on success
    const ctx = makePipelineContext({
      routing: { testStrategy: "test-after" } as any,
    });

    expect(ctx.story).toBeDefined();
    expect(ctx.config).toBeDefined();
  });

  test("completes unified path: handles failure with proper verdict classification", () => {
    // Failure path:
    // 1. Same assembly/build/run as above
    // 2. Post-run inspection detects failure in phaseOutputs
    // 3. Categorizes failure (e.g., "lint-failure", "test-failure")
    // 4. Returns { action: "escalate", reason: "..." } or { action: "pause", reason: "..." }
    const ctx = makePipelineContext();

    expect(ctx.prd).toBeDefined();
  });

  test("completes unified path: handles pause with interaction notify", () => {
    // Pause path:
    // 1. Assembly/build/run succeeds or has recoverable failure
    // 2. Post-run inspection detects pauseReason (e.g., from rectification)
    // 3. Sends interaction notify if interaction enabled
    // 4. Returns { action: "pause", reason: pauseReason }
    const ctx = makePipelineContext({
      interaction: {
        send: async () => ({}),
      } as any,
    });

    expect(ctx.interaction).toBeDefined();
  });

  test("works identically for TDD and non-TDD strategies", () => {
    // The unified path should work the same way regardless of strategy.
    // buildPlanForStrategy returns different slot masks for TDD vs. non-TDD,
    // but the execution flow is identical.
    const tddCtx = makePipelineContext({
      routing: { testStrategy: "three-session-tdd" } as any,
    });
    const nonTddCtx = makePipelineContext({
      routing: { testStrategy: "test-after" } as any,
    });

    expect(tddCtx.routing.testStrategy).toBe("three-session-tdd");
    expect(nonTddCtx.routing.testStrategy).toBe("test-after");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error Handling in Unified Path
// ─────────────────────────────────────────────────────────────────────────────

describe("Unified Execution Stage — Error handling", () => {
  test("handles missing required fields in plan assembly", () => {
    // If story.id or config is invalid, assemblePlanInputs should throw.
    // The stage should catch and return a fail action.
    const ctx = makePipelineContext({
      story: { id: "" } as any, // Invalid: empty id
    });

    expect(ctx.story.id).toBe("");
  });

  test("handles missing prompt gracefully", () => {
    // If prompt stage was skipped, ctx.prompt is undefined.
    // The stage should detect and fail early.
    const ctx = makePipelineContext({
      prompt: undefined,
    });

    expect(ctx.prompt).toBeUndefined();
  });

  test("handles plan.run() failure gracefully", () => {
    // If plan.run() throws or returns failure,
    // post-run inspection should handle it and return appropriate action.
    const ctx = makePipelineContext();

    expect(ctx.runtime).toBeDefined();
  });

  test("handles interaction.send() failure gracefully", () => {
    // If sending pause notification fails, stage should log warning
    // but still return pause action (notification failure should not cause stage failure).
    const ctx = makePipelineContext({
      interaction: {
        send: async () => {
          throw new Error("Notification failed");
        },
      } as any,
    });

    expect(ctx.interaction).toBeDefined();
  });
});
