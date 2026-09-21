/**
 * StoryOrchestrator runPhase — story:phase:completed event emission
 *
 * Covers US-002 (Story-phase event emission and outcome derivation).
 *
 * The contract: every `runPhase` invocation emits exactly one
 * `story:phase:completed` event whose `outcome` is derived from the operation
 * output or thrown error, `costUsd` is the invocation's own scope snapshot total
 * (NOT the accumulated `phaseCosts` entry), and `durationMs` is the elapsed
 * operation-dispatch time. Subscriber exceptions are fail-open.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertDefined,
  makeAdversarialReviewConfig,
  makeNaxConfig,
  makeSemanticReviewConfig,
  makeStory,
  makeTestContext,
  makeTestRuntime,
} from "@test/helpers";
import { pickSelector } from "@/config";
import { NaxError } from "@/errors";
import {
  _storyOrchestratorDeps,
  phasePassed,
  runPhase,
  StoryOrchestratorBuilder,
  type StoryOrchestratorResult,
  toReviewDecisionPayload,
} from "@/execution";
import { applyReviewsFailedOpen } from "@/execution/post-run-review-summary";
import type { AnySlot } from "@/execution/story-orchestrator";
import type { Finding } from "@/findings/types";
import type { CallContext, RunOperation } from "@/operations";
import { pipelineEventBus, type StoryPhaseCompletedEvent } from "@/pipeline";
import type { CostScopeHandle, NaxRuntime } from "@/runtime";
import type { ReviewDecisionEvent } from "@/runtime/dispatch-events";

/**
 * The op slot `runPhase` accepts, NOT `callOp`'s parameter. `callOp` takes the
 * full `Operation` union (complete-kind included); a phase slot is narrower —
 * run-kind or deterministic only. Widening this alias to `callOp`'s made every
 * `makeSlot()` unassignable to `runPhase`.
 */
type AnyOp = AnySlot["op"];

function makeCallCtx(): CallContext {
  const runtime = makeTestRuntime();
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/x",
    agentName: "claude",
    storyId: "US-002",
  };
}

function makeOp(name: string): AnyOp {
  return {
    name,
    stage: "verify",
    kind: "run",
    config: [],
    session: { role: "main", lifetime: "fresh" },
    build: () => ({
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: "", overridable: false },
    }),
    parse: () => ({}),
  };
}

function makeSlot(opName: string) {
  return { op: makeOp(opName), input: {} };
}

/**
 * #1960 — stub openScope so the phase's scope snapshot reports exactly the
 * halves the test seeds. `openScope`'s own error handling is covered in
 * cost-aggregator.test.ts; here the snapshot's contents are the fixture.
 */
function withScopeSnapshot(runtime: NaxRuntime, snap: { totalCostUsd: number; totalErrorCostUsd: number }): void {
  const realOpenScope = runtime.costAggregator.openScope.bind(runtime.costAggregator);
  runtime.costAggregator.openScope = ((scopeId?: string): CostScopeHandle => {
    const handle = realOpenScope(scopeId);
    return {
      scopeId: handle.scopeId,
      snapshot: () => ({
        ...handle.snapshot(),
        ...snap,
      }),
      close: handle.close,
    };
  }) as typeof runtime.costAggregator.openScope;
}

function ctxWithRuntime(runtime: NaxRuntime): CallContext {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/x",
    agentName: "claude",
    storyId: "US-002",
  };
}

const origCallOp = _storyOrchestratorDeps.callOp;
const origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
let runtime: NaxRuntime | undefined;

beforeEach(() => {
  pipelineEventBus.clear();
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  pipelineEventBus.clear();
  await runtime?.close();
  runtime = undefined;
});

describe("runPhase — story:phase:completed event emission", () => {
  test("AC1: emits exactly one story:phase:completed event for a passing operation", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received).toHaveLength(1);
    unsub();
  });

  test("AC2: emitted event phase equals the operation name", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("lint-check"), {}, {});

    expect(received[0].phase).toBe("lint-check");
    unsub();
  });

  test("AC3: outcome is 'passed' when operation returns { passed: true }", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].outcome).toBe("passed");
    unsub();
  });

  test("AC4: outcome is 'failed' when operation returns { passed: false }", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: false })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].outcome).toBe("failed");
    unsub();
  });

  test("AC5: outcome is 'skipped' when operation returns { status: 'skipped' }", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ status: "skipped" })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("lint-check"), {}, {});

    expect(received[0].outcome).toBe("skipped");
    unsub();
  });

  test("AC6: outcome is 'error' when operation throws", async () => {
    _storyOrchestratorDeps.callOp = (async () => {
      throw new Error("boom");
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await expect(runPhase(ctx, makeSlot("verifier"), {}, {})).rejects.toThrow("boom");

    expect(received).toHaveLength(1);
    expect(received[0].outcome).toBe("error");
    unsub();
  });

  test("AC7: rethrows the original error unchanged", async () => {
    const sentinel = new Error("original-error-sentinel");
    _storyOrchestratorDeps.callOp = (async () => {
      throw sentinel;
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const ctx = makeCallCtx();
    const thrown = await runPhase(ctx, makeSlot("verifier"), {}, {}).catch((e: unknown) => e);
    expect(thrown).toBe(sentinel);
  });

  test("AC8: outcome is 'passed' when operation returns a non-object value (string)", async () => {
    _storyOrchestratorDeps.callOp = (async () => "some-string") as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].outcome).toBe("passed");
    unsub();
  });

  test("AC9: event has no 'details' field for non-object output", async () => {
    _storyOrchestratorDeps.callOp = (async () => 42) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].outcome).toBe("passed");
    expect(received[0]).not.toHaveProperty("details");
    unsub();
  });

  test("AC10: outcome is 'passed' when buildPhaseOutcomeLogData reports success", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      status: "passed",
    })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("full-suite-gate"), {}, {});

    expect(received[0].outcome).toBe("passed");
    unsub();
  });

  test("gate-op skip envelope { success: true, status: 'skipped' } emits 'passed' (buildPhaseOutcomeLogData reports success)", async () => {
    // Real-world gate-ops (lint-check, typecheck-check, full-suite-gate, verify-scoped)
    // return { success: true, status: 'skipped' } when skipping. buildPhaseOutcomeLogData
    // reports success for this envelope, so AC10 mandates the outcome be 'passed'.
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      passed: true,
      status: "skipped",
      findings: [],
    })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("full-suite-gate"), {}, {});

    expect(received[0].outcome).toBe("passed");
    unsub();
  });

  test("AC11: semantic-review emits an outcome even though deterministic logging returns early", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({
      passed: false,
      findings: [],
    })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("semantic-review"), {}, {});

    expect(received).toHaveLength(1);
    expect(received[0].outcome).toBe("failed");
    unsub();
  });

  test("AC12: emitted costUsd equals the invocation's scope snapshot total, not the accumulated phaseCosts", async () => {
    const runtime = makeTestRuntime();
    const scopeCosts: Record<string, number> = { verifier: 0.123, implementer: 0.999 };
    let openCount = 0;
    const realOpenScope = runtime.costAggregator.openScope.bind(runtime.costAggregator);
    runtime.costAggregator.openScope = ((scopeId?: string): CostScopeHandle => {
      openCount += 1;
      const handle = realOpenScope(scopeId);
      const opName = openCount === 1 ? "verifier" : "implementer";
      const expected = scopeCosts[opName] ?? 0;
      return {
        scopeId: handle.scopeId,
        snapshot: () => ({
          ...handle.snapshot(),
          totalCostUsd: expected,
        }),
        close: handle.close,
      };
    }) as typeof runtime.costAggregator.openScope;

    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp/x",
      agentName: "claude",
      storyId: "US-002",
    };

    // Pre-seed the accumulated phaseCosts for this phase — the event must NOT
    // pick this up. The phaseCosts arg is updated by runPhase's finally block,
    // so by the time the test asserts, phaseCosts[opName] would already include
    // the new scope snapshot's totalCostUsd. Verify the emitted event reflects
    // the scope snapshot, not an even higher value.
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].costUsd).toBe(0.123);
    unsub();
  });

  test("AC13: emitted durationMs equals elapsed operation-dispatch time", async () => {
    _storyOrchestratorDeps.callOp = (async () => {
      await new Promise((r) => setTimeout(r, 25));
      return { passed: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      received.push(e);
    });

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].durationMs).toBeGreaterThanOrEqual(20);
    unsub();
  });

  test("AC14: runPhase returns operation output normally when a subscriber throws", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const unsub = pipelineEventBus.on("story:phase:completed", () => {
      throw new Error("subscriber boom");
    });

    const ctx = makeCallCtx();
    const output = await runPhase(ctx, makeSlot("verifier"), {}, {});
    expect(output).toEqual({ passed: true });
    unsub();
  });

  test("#1960: costUsd folds failed-dispatch spend and errorCostUsd names the failed half", async () => {
    const runtime = makeTestRuntime();
    // The phase's scope recorded a successful 0.02 row and a failed 0.005 row.
    withScopeSnapshot(runtime, { totalCostUsd: 0.02, totalErrorCostUsd: 0.005 });
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const events: Array<{ costUsd: number; errorCostUsd?: number }> = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      events.push({ costUsd: e.costUsd, errorCostUsd: e.errorCostUsd });
    });

    await runPhase(ctxWithRuntime(runtime), makeSlot("verifier"), {}, {});
    unsub();

    expect(events[0]?.costUsd).toBe(0.025);
    expect(events[0]?.errorCostUsd).toBe(0.005);
  });

  test("#1960: errorCostUsd is absent when the phase had no failed dispatch", async () => {
    // Same harness, aggregator seeded with a successful row only.
    const runtime = makeTestRuntime();
    withScopeSnapshot(runtime, { totalCostUsd: 0.02, totalErrorCostUsd: 0 });
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const events: Array<{ costUsd: number; errorCostUsd?: number }> = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
      events.push({ costUsd: e.costUsd, errorCostUsd: e.errorCostUsd });
    });

    await runPhase(ctxWithRuntime(runtime), makeSlot("verifier"), {}, {});
    unsub();

    expect(events[0]?.costUsd).toBe(0.02);
    expect(events[0]?.errorCostUsd).toBeUndefined();
  });

  test("#1960: phaseCosts accumulates total spend, not successful spend", async () => {
    const runtime = makeTestRuntime();
    withScopeSnapshot(runtime, { totalCostUsd: 0.02, totalErrorCostUsd: 0.005 });
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const opName = "verifier";
    const phaseCosts: Record<string, number> = {};
    await runPhase(ctxWithRuntime(runtime), makeSlot(opName), phaseCosts, {});

    expect(phaseCosts[opName]).toBe(0.025);
  });
});

// ===========================================================================
// US-002 — review no-dispatch (absorbed from
// story-orchestrator-review-no-dispatch.test.ts)
// ===========================================================================

const testSel = pickSelector("test-review-no-dispatch-selector", "execution");
type TestOpConfig = ReturnType<(typeof testSel)["select"]>;

const mockImplementerOp: RunOperation<{ code: string }, { success: boolean }, TestOpConfig> = {
  kind: "run",
  name: "mock-implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: (input) => ({
    role: { id: "r1", content: "Implement", overridable: false },
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

function buildCtx(rt: NaxRuntime, storyId: string): CallContext {
  return {
    runtime: rt,
    packageView: rt.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
  };
}

function buildPlan(rt: NaxRuntime, storyId: string) {
  const story = makeStory({ id: storyId, acceptanceCriteria: ["AC1: returns 200 on success"] });
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: mockImplementerOp, input: { code: "" } })
    .addSemanticReview({
      workdir: "/tmp",
      story,
      semanticConfig: makeSemanticReviewConfig(),
      mode: "ref",
    })
    .addAdversarialReview({
      workdir: "/tmp",
      story,
      adversarialConfig: makeAdversarialReviewConfig(),
      mode: "ref",
    })
    .build(buildCtx(rt, storyId));
}

/** Runs the plan, capturing (rather than letting escape) any error the phase propagated. */
async function runOrchestrator(
  storyId: string,
  onRuntime?: (rt: NaxRuntime) => void,
): Promise<{ result?: StoryOrchestratorResult; error?: unknown }> {
  runtime = makeTestRuntime({ config: makeNaxConfig() });
  onRuntime?.(runtime);
  const plan = buildPlan(runtime, storyId);
  try {
    return { result: await plan.run() };
  } catch (error) {
    return { error };
  }
}

/**
 * The zero-dispatch seam: `callOp` raises `CALL_OP_NO_DISPATCH` for the named
 * review phases, the way US-001 does when every hop of the operation ended
 * without returning a turn.
 */
function stubZeroDispatchReview(phases: readonly string[] = ["semantic-review", "adversarial-review"]): void {
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
    if (phases.includes(op.name)) {
      throw new NaxError(`callOp[${op.name}]: no dispatch completed`, "CALL_OP_NO_DISPATCH", {
        stage: "review",
        storyId: "US-002",
        agentName: "claude",
      });
    }
    return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
  }) as typeof _storyOrchestratorDeps.callOp;
}

/**
 * A review phase output, read as an object. `phaseOutputs` is `Record<string, unknown>`
 * by design (it carries every op's envelope), so the shape each test asserts on is
 * named in the assertion rather than forced through a cast.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function reviewOutput(result: StoryOrchestratorResult, phase: string): Record<string, unknown> {
  const output = result.phaseOutputs[phase];
  assertDefined(output, `${phase} phase output`);
  if (!isRecord(output)) throw new Error(`${phase} phase output is not an object`);
  return output;
}

describe("US-002 AC1/AC2 — the semantic review phase fails closed with a noDispatch check result", () => {
  test("AC1: a CALL_OP_NO_DISPATCH dispatch yields noDispatch:true and success:false", async () => {
    stubZeroDispatchReview(["semantic-review"]);
    const { result, error } = await runOrchestrator("US-002-ac1");
    expect(error).toBeUndefined();
    assertDefined(result, "orchestrator result");

    const semantic = reviewOutput(result, "semantic-review");
    expect(semantic.noDispatch).toBe(true);
    expect(semantic.success).toBe(false);
    expect(semantic.check).toBe("semantic");
  });

  test("AC2: the noDispatch check result never claims fail-open", async () => {
    stubZeroDispatchReview(["semantic-review"]);
    const { result } = await runOrchestrator("US-002-ac2");
    assertDefined(result, "orchestrator result");

    const semantic = reviewOutput(result, "semantic-review");
    expect(semantic.failOpen).not.toBe(true);
    expect(semantic.passed).not.toBe(true);
  });
});

describe("US-002 AC3 — the adversarial review phase returns noDispatch instead of propagating", () => {
  test("a CALL_OP_NO_DISPATCH dispatch yields a noDispatch check result", async () => {
    stubZeroDispatchReview(["adversarial-review"]);
    const { result, error } = await runOrchestrator("US-002-ac3");
    // The dispatch error must not escape the phase.
    expect(error).toBeUndefined();
    assertDefined(result, "orchestrator result");

    const adversarial = reviewOutput(result, "adversarial-review");
    expect(adversarial.noDispatch).toBe(true);
    expect(adversarial.success).toBe(false);
    expect(adversarial.check).toBe("adversarial");
    expect(adversarial.failOpen).not.toBe(true);
  });
});

describe("US-002 AC4 — a completed dispatch whose output is unusable still fails open", () => {
  test("fail-open output is recorded as failOpen:true and never stamped noDispatch", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "semantic-review") {
        return { passed: true, findings: [], normalizedFindings: [], acDropped: [], failOpen: true };
      }
      return { passed: true, findings: [], normalizedFindings: [], acDropped: [] };
    }) as typeof _storyOrchestratorDeps.callOp;

    const { result } = await runOrchestrator("US-002-ac4");
    assertDefined(result, "orchestrator result");

    const semantic = reviewOutput(result, "semantic-review");
    expect(semantic.failOpen).toBe(true);
    expect(semantic.noDispatch).not.toBe(true);
    // Unchanged by this story: a fail-open review still passes its own phase.
    expect(phasePassed("semantic-review", result.phaseOutputs["semantic-review"], "US-002-ac4")).toBe(true);
  });
});

describe("US-002 AC5 — a noDispatch check result does not inflate the fail-open tally", () => {
  test("applyReviewsFailedOpen leaves reviewsFailedOpen unset for zero-dispatch reviews", async () => {
    stubZeroDispatchReview();
    const { result } = await runOrchestrator("US-002-ac5");
    assertDefined(result, "orchestrator result");

    const ctx = makeTestContext();
    applyReviewsFailedOpen(ctx, result.phaseOutputs);
    expect(ctx.reviewsFailedOpen).toBeUndefined();
  });
});

describe("US-002 — only a zero-dispatch review error is converted", () => {
  test("a review phase that fails for another reason still propagates its error", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "semantic-review") throw new Error("reviewer exploded");
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    }) as typeof _storyOrchestratorDeps.callOp;

    const { result, error } = await runOrchestrator("US-002-boundary-1");
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
  });

  test("a CALL_OP_NO_DISPATCH on a non-review phase is not converted", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "mock-implementer") {
        throw new NaxError("callOp[mock-implementer]: no dispatch completed", "CALL_OP_NO_DISPATCH", {
          stage: "run",
          storyId: "US-002",
          agentName: "claude",
        });
      }
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    }) as typeof _storyOrchestratorDeps.callOp;

    const { result, error } = await runOrchestrator("US-002-boundary-2");
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(NaxError);
  });

  test("noDispatch wins over a malformed fail-open stamp at the decision seam", () => {
    // The interface's mutual exclusion, enforced by the consumer: even if a
    // producer stamped both, a review that never dispatched must not be read as
    // a degraded pass.
    const payload = toReviewDecisionPayload("semantic-review", {
      noDispatch: true,
      failOpen: true,
      passed: true,
      findings: [],
    });
    assertDefined(payload, "review decision payload");
    expect(payload).toMatchObject({ parsed: false, passed: false, noDispatch: true });
    if (!payload.parsed) expect(payload.failOpen).not.toBe(true);
  });
});

describe("US-002 AC6 — a zero-dispatch review does not pass story-level review", () => {
  test("the story verdict fails when both review gates never dispatched", async () => {
    stubZeroDispatchReview();
    const { result, error } = await runOrchestrator("US-002-ac6");
    expect(error).toBeUndefined();
    assertDefined(result, "orchestrator result");

    expect(result.success).toBe(false);
    expect(phasePassed("semantic-review", result.phaseOutputs["semantic-review"], "US-002-ac6")).toBe(false);
    expect(phasePassed("adversarial-review", result.phaseOutputs["adversarial-review"], "US-002-ac6")).toBe(false);
  });

  test("the review decision for a zero-dispatch review is a failed, unparsed decision", async () => {
    stubZeroDispatchReview(["semantic-review"]);
    const decisions: ReviewDecisionEvent[] = [];
    const { result } = await runOrchestrator("US-002-ac6b", (rt) =>
      rt.dispatchEvents.onReviewDecision((event) => {
        decisions.push(event);
      }),
    );
    assertDefined(result, "orchestrator result");

    const payload = toReviewDecisionPayload("semantic-review", result.phaseOutputs["semantic-review"]);
    assertDefined(payload, "review decision payload");
    expect(payload).toMatchObject({ parsed: false, passed: false, noDispatch: true });

    // The state survives the emit seam too — an operator reading the review
    // audit must see "no model was reached", not a generic give-up.
    const semanticDecision = decisions.find((event) => event.reviewer === "semantic");
    assertDefined(semanticDecision, "emitted semantic review decision");
    expect(semanticDecision).toMatchObject({ parsed: false, passed: false, noDispatch: true });
    expect(semanticDecision.failOpen).not.toBe(true);
  });
});

// ===========================================================================
// AC6: extractPhaseFindings (absorbed from
// story-orchestrator-extract-findings.test.ts)
// ===========================================================================

const F1: Finding = {
  source: "tdd-verifier",
  severity: "error",
  category: "tests-failed",
  message: "2 tests failed",
  fixTarget: "source",
};

const F2: Finding = {
  source: "tdd-verifier",
  severity: "error",
  category: "illegitimate-test-edits",
  message: "test file edited",
  fixTarget: "test",
};

function makeVerifierOutput(normalizedFindings: Finding[]) {
  return {
    success: false,
    filesChanged: [] as string[],
    estimatedCostUsd: 0,
    durationMs: 0,
    output: "",
    normalizedFindings,
  };
}

describe("AC6: extractPhaseFindings exported from story-orchestrator", () => {
  test("AC6: extractPhaseFindings is a named export of story-orchestrator", async () => {
    const mod = await import("@/execution/story-orchestrator");
    expect(typeof mod.extractPhaseFindings).toBe("function");
  });

  test("AC6: returns F1 and F2 when normalizedFindings is [F1, F2]", async () => {
    const { extractPhaseFindings } = await import("@/execution/story-orchestrator");

    const output = makeVerifierOutput([F1, F2]);
    const findings = extractPhaseFindings(output);

    expect(findings).toContain(F1);
    expect(findings).toContain(F2);
  });

  test("AC6: returned array length equals normalizedFindings length", async () => {
    const { extractPhaseFindings } = await import("@/execution/story-orchestrator");

    const output = makeVerifierOutput([F1, F2]);
    const findings = extractPhaseFindings(output);

    expect(findings.length).toBe(2);
  });

  test("AC6: returns empty array when normalizedFindings is []", async () => {
    const { extractPhaseFindings } = await import("@/execution/story-orchestrator");

    const output = makeVerifierOutput([]);
    const findings = extractPhaseFindings(output);

    expect(findings.length).toBe(0);
  });

  test("AC6: returns empty array when output is null", async () => {
    const { extractPhaseFindings } = await import("@/execution/story-orchestrator");

    const findings = extractPhaseFindings(null);

    expect(findings.length).toBe(0);
  });
});
