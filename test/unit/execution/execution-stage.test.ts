// RE-ARCH: keep
/**
 * Tests for src/pipeline/stages/execution.ts
 *
 * Covers: routeTddFailure, execution stage critical paths
 */

import { describe, expect, it } from "bun:test";
import { _executionDeps, executionStage, routeTddFailure } from "@/pipeline/stages/execution";
import type { FailureCategory } from "@/tdd";
import { NaxError } from "@/errors";
import { makeAgentAdapter, makeNaxConfig } from "@test/helpers";
import { makeTestContext, makeTestStory, withExecutionDeps } from "@test/helpers";
import type { PipelineContext } from "@/pipeline/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface MockContext {
  retryAsLite?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// routeTddFailure
// ─────────────────────────────────────────────────────────────────────────────

describe("routeTddFailure", () => {
  it("escalates on isolation-violation in strict mode with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("isolation-violation", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD isolation-violation");
    expect(ctx.retryAsLite).toBe(true);
  });

  it("escalates on isolation-violation in lite mode without setting retryAsLite", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("isolation-violation", true, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD isolation-violation");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on session-failure with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("session-failure", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD session-failure");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on tests-failing with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("tests-failing", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD tests-failing");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on full-suite-gate-exhausted with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("full-suite-gate-exhausted", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD full-suite-gate-exhausted");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on verifier-rejected with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("verifier-rejected", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD verifier-rejected");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on review-incomplete with category in reason (US-002)", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("review-incomplete", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD review-incomplete");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on greenfield-no-tests with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("greenfield-no-tests", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD greenfield-no-tests");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("appends failureDetail to escalate reason when provided", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("tests-failing", false, ctx, undefined, "3 tests failing in foo.test.ts");

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD tests-failing: 3 tests failing in foo.test.ts");
  });

  it("pauses on undefined failureCategory", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure(undefined, false, ctx, "Unknown failure");

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Unknown failure");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("pauses on unknown failureCategory", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("unknown" as FailureCategory, false, ctx);

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Three-session TDD requires review");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("pauses on dependency-prep (infra prep failure, not tier-recoverable)", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("dependency-prep", false, ctx);

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Three-session TDD requires review");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("pauses on test-incorrect with the verifier's review reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("test-incorrect", false, ctx, "Incorrect assertion; human review required");

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Incorrect assertion; human review required");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("uses custom reviewReason when pausing", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure(undefined, false, ctx, "Custom reason for pause");

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Custom reason for pause");
  });

  it("defaults to generic pause message when no reviewReason provided", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure(undefined, false, ctx);

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Three-session TDD requires review");
  });

  it("handles all known failure categories correctly", () => {
    const categories: FailureCategory[] = [
      "isolation-violation",
      "session-failure",
      "tests-failing",
      "full-suite-gate-exhausted",
      "verifier-rejected",
      "runtime-crash",
    ];

    for (const category of categories) {
      const ctx: MockContext = {};
      const result = routeTddFailure(category, false, ctx);
      expect(result.action).toBe("escalate");
    }
  });

  it("only sets retryAsLite for isolation-violation in strict mode", () => {
    const categories: FailureCategory[] = [
      "session-failure",
      "tests-failing",
      "full-suite-gate-exhausted",
      "verifier-rejected",
    ];

    for (const category of categories) {
      const ctx: MockContext = {};
      routeTddFailure(category, false, ctx);
      expect(ctx.retryAsLite).toBeUndefined();
    }
  });

  // issue #1132
  it("escalates on runtime-crash with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("runtime-crash", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD runtime-crash");
    expect(ctx.retryAsLite).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executionStage.execute — runtime-crash category on plan.run() throw (#1132)
// ─────────────────────────────────────────────────────────────────────────────

describe("executionStage.execute — runtime-crash on thrown infra errors", () => {
  const cfg = makeNaxConfig();

  // Shared PipelineContext factory — overrides only the fields execution stage needs.
  function makeCtx(): PipelineContext {
    return makeTestContext({
      story: makeTestStory({ id: "US-crash-01", title: "Crash test" }),
      config: cfg,
      workdir: "/tmp/nax-crash-test",
      routing: { modelTier: "fast", testStrategy: "three-session-tdd", agent: "claude", complexity: "simple", reasoning: "" },
      packageView: { select: () => cfg } as unknown as PipelineContext["packageView"],
      // runtime lives on the DispatchContext parent — cast to satisfy Partial<PipelineContext>
      ...({
        runtime: {
          dispatchEvents: { onDispatch: () => () => {} },
          signal: undefined,
          packages: undefined,
          onPidSpawned: undefined,
        },
      } as unknown as Partial<PipelineContext>),
    });
  }

  // Stub _executionDeps so plan.run() is the only thing that can throw.
  // Returns a restore function — call it in the test's own finally block.
  function stubDepsWithPlan(planRun: () => Promise<never>): () => void {
    const overrides = {
      getAgent: () => makeAgentAdapter({ name: "claude" }) as never,
      validateAgentForTier: () => true,
      captureGitRef: async () => "HEAD",
      getUntrackedPaths: async () => [],
      assemblePlanInputsFromCtx: async () => ({}) as never,
      buildPlanForStrategy: async () => ({ run: planRun }) as never,
    };
    return withExecutionDeps(overrides);
  }

  it("sets tddFailureCategory to runtime-crash when plan.run() throws CALL_OP_NO_OUTPUT", async () => {
    // AC-1: CALL_OP_NO_OUTPUT → runtime-crash
    const ctx = makeCtx();
    const restore = stubDepsWithPlan(async () => {
      throw new NaxError("agent returned no output", "CALL_OP_NO_OUTPUT", {
        stage: "execution",
        storyId: "US-crash-01",
      });
    });
    let threw = false;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      threw = true;
      expect((err as NaxError).code).toBe("CALL_OP_NO_OUTPUT");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(ctx.tddFailureCategory).toBe("runtime-crash");
  });

  it("sets tddFailureCategory to runtime-crash when plan.run() throws CALL_OP_MAX_RETRIES", async () => {
    // AC-1: CALL_OP_MAX_RETRIES → runtime-crash
    const ctx = makeCtx();
    const restore = stubDepsWithPlan(async () => {
      throw new NaxError("retry budget exhausted", "CALL_OP_MAX_RETRIES", {
        stage: "execution",
        storyId: "US-crash-01",
      });
    });
    let threw = false;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      threw = true;
      expect((err as NaxError).code).toBe("CALL_OP_MAX_RETRIES");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(ctx.tddFailureCategory).toBe("runtime-crash");
  });

  it("does NOT set tddFailureCategory when plan.run() throws CALL_OP_ABORTED", async () => {
    // AC-3: user-initiated abort must not be classified as runtime-crash
    const ctx = makeCtx();
    const restore = stubDepsWithPlan(async () => {
      throw new NaxError("aborted", "CALL_OP_ABORTED", {
        stage: "execution",
        storyId: "US-crash-01",
      });
    });
    let threw = false;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      threw = true;
      expect((err as NaxError).code).toBe("CALL_OP_ABORTED");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(ctx.tddFailureCategory).toBeUndefined();
  });
});
