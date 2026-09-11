/**
 * US-002 — "Fail closed when a review has no dispatch".
 *
 * The two review phases consume US-001's `CALL_OP_NO_DISPATCH`: when `callOp`
 * reports that no hop of a review operation ever returned a turn, the phase must
 * record a failed `noDispatch` check result instead of propagating the dispatch
 * error (adversarial) or degrading to a fail-open pass (semantic).
 *
 * AC1 — the semantic review phase's check result has `noDispatch: true` and `success: false`.
 * AC2 — that check result is not fail-open.
 * AC3 — the adversarial review phase returns a `noDispatch` check result rather
 *       than propagating the dispatch error.
 * AC4 — a completed dispatch whose output cannot be parsed still fails open and
 *       is never stamped `noDispatch`.
 * AC5 — a `noDispatch` check result does not increment the fail-open tally.
 * AC6 — the story does not pass story-level review when a review never dispatched.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
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
import type { StoryOrchestratorResult } from "@/execution";
import { _storyOrchestratorDeps, phasePassed, StoryOrchestratorBuilder, toReviewDecisionPayload } from "@/execution";
import { applyReviewsFailedOpen } from "@/execution/post-run-review-summary";
import type { CallContext, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import type { ReviewDecisionEvent } from "@/runtime/dispatch-events";

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

let runtime: NaxRuntime | undefined;
const origCallOp = _storyOrchestratorDeps.callOp;
afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  await runtime?.close();
  runtime = undefined;
});

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
