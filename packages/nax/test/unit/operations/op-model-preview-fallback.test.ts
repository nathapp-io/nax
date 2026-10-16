/**
 * `previewOpModel`'s fallback branch (US-004, nax#2491 follow-up): a workflow start line must
 * name the endpoint the step will really start on. When the op's primary endpoint is already
 * unavailable and fallback is enabled, run-kind dispatch skips the dead primary, so the start
 * line has to name the first fallback candidate and its model instead.
 *
 * The agent manager's two fallback probes are scripted here — `makeMockAgentManager` hard-codes
 * `isUnavailable: () => false` and `nextCandidate: () => null`, so every test below installs its
 * own. Both are `mock()`s, which is what lets a test assert the candidate lookup never ran.
 */
import { describe, expect, mock, test } from "bun:test";
import { makeMockAgentManager, makeMockCallContext, makeMockRuntime, makeNaxConfig } from "@test/helpers";
import type { FallbackTarget } from "@/agents/swap-decision";
import { classifyRouteOp, previewOpModel, workflowStoryReviewOp } from "@/operations";
import type { CallContext } from "@/operations/types";

const MODELS = {
  claude: { fast: "model-a", balanced: "model-b", powerful: "model-c" },
  native: { fast: "model-n1", balanced: "model-n2", powerful: "model-n3" },
};

/** A run-kind op that resolves to `native` at the `balanced` tier under MODELS. */
const reviewInput = { prompt: "", timeoutMs: 1 };

interface FallbackFixture {
  readonly ctx: CallContext;
  readonly isUnavailable: ReturnType<typeof mock>;
  readonly nextCandidate: ReturnType<typeof mock>;
}

function fixture(opts: {
  readonly unavailable: boolean;
  readonly candidate: FallbackTarget | null;
  readonly fallbackEnabled?: boolean;
}): FallbackFixture {
  const agentManager = makeMockAgentManager();
  const isUnavailable = mock(() => opts.unavailable);
  const nextCandidate = mock(() => opts.candidate);
  agentManager.isUnavailable = isUnavailable;
  agentManager.nextCandidate = nextCandidate;
  const config = makeNaxConfig({ models: MODELS, agent: { fallback: { enabled: opts.fallbackEnabled ?? true } } });
  const runtime = makeMockRuntime({ config, agentManager });
  return { ctx: makeMockCallContext({ runtime, agentName: "native" }), isUnavailable, nextCandidate };
}

describe("previewOpModel — unavailable primary (run-kind)", () => {
  test("names the fallback candidate's agent and its model for the candidate's tier", () => {
    const { ctx, isUnavailable, nextCandidate } = fixture({
      unavailable: true,
      candidate: { agent: "claude", tier: "balanced" },
    });
    expect(previewOpModel(ctx, workflowStoryReviewOp, reviewInput)).toEqual({
      agentName: "claude",
      model: MODELS.claude.balanced,
    });
    expect(isUnavailable).toHaveBeenCalledWith("native", "balanced", MODELS.native.balanced);
    expect(nextCandidate).toHaveBeenCalledWith("native", 0);
  });

  test("keeps a candidate's literal model pin verbatim", () => {
    const { ctx } = fixture({ unavailable: true, candidate: { agent: "claude", model: "opus" } });
    expect(previewOpModel(ctx, workflowStoryReviewOp, reviewInput)).toEqual({ agentName: "claude", model: "opus" });
  });

  test("names the primary endpoint when fallback is disabled", () => {
    const { ctx, nextCandidate } = fixture({
      unavailable: true,
      candidate: { agent: "claude", tier: "balanced" },
      fallbackEnabled: false,
    });
    expect(previewOpModel(ctx, workflowStoryReviewOp, reviewInput)).toEqual({
      agentName: "native",
      model: MODELS.native.balanced,
    });
    expect(nextCandidate).not.toHaveBeenCalled();
  });

  test("names the primary endpoint when there is no candidate", () => {
    const { ctx } = fixture({ unavailable: true, candidate: null });
    expect(previewOpModel(ctx, workflowStoryReviewOp, reviewInput)).toEqual({
      agentName: "native",
      model: MODELS.native.balanced,
    });
  });

  test("returns undefined when the candidate's endpoint resolves no model", () => {
    const { ctx } = fixture({ unavailable: true, candidate: { agent: "gemini", tier: "glm" } });
    expect(previewOpModel(ctx, workflowStoryReviewOp, reviewInput)).toBeUndefined();
  });

  test("never looks up a candidate while the primary is available", () => {
    const { ctx, nextCandidate } = fixture({
      unavailable: false,
      candidate: { agent: "claude", tier: "balanced" },
    });
    expect(previewOpModel(ctx, workflowStoryReviewOp, reviewInput)).toEqual({
      agentName: "native",
      model: MODELS.native.balanced,
    });
    expect(nextCandidate).not.toHaveBeenCalled();
  });
});

describe("previewOpModel — complete-kind ops", () => {
  test("names the primary even when it is unavailable, and never looks up a candidate", () => {
    const { ctx, nextCandidate } = fixture({
      unavailable: true,
      candidate: { agent: "claude", tier: "balanced" },
    });
    expect(
      previewOpModel(ctx, classifyRouteOp, { title: "t", description: "d", acceptanceCriteria: ["a"], tags: [] }),
    ).toEqual({ agentName: "native", model: MODELS.native.fast });
    expect(nextCandidate).not.toHaveBeenCalled();
  });
});
