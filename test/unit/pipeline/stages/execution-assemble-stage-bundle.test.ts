/**
 * nax#1737 Phase B — the execution stage must hand `runPhase` a way to
 * assemble a bundle for a context-engine stage key on demand, without giving
 * the operations layer (CallContext) the full PipelineContext.
 *
 * `assembleStageBundle` is a closure over the PipelineContext that delegates
 * to `_executionDeps.assembleForStage` (the repo `_deps` convention — see
 * docs/architecture/) so tests can stub the assembly without touching the
 * real context-engine orchestrator.
 *
 * Reuses the harness from execution-context-bundle.test.ts (Phase A).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeAgentAdapter, makeContextBundle, makeNaxConfig, makeStory, makeTestContext } from "@test/helpers";
import type { ConfigSelector } from "@/config";
import { _storyOrchestratorDeps, ExecutionPlan } from "@/execution";
import type { CallContext } from "@/operations/types";
import { _executionDeps, executionStage } from "@/pipeline";
import type { PipelineContext, RoutingResult } from "@/pipeline/types";

const BASE_ROUTING: RoutingResult = {
  complexity: "simple",
  modelTier: "fast",
  testStrategy: "test-after",
  reasoning: "",
  agent: "claude",
};

function makePipelineContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config = makeNaxConfig();
  return makeTestContext({
    config,
    rootConfig: config,
    routing: BASE_ROUTING,
    packageView: {
      packageDir: "/tmp/test",
      relativeFromRoot: "",
      repoRoot: "/tmp/test",
      hasOverride: false,
      config,
      select: <C>(selector: ConfigSelector<C>) => selector.select(config),
    },
    ...overrides,
  });
}

let orig: typeof _executionDeps;
let origCaptureTreeState: typeof _storyOrchestratorDeps.captureTreeState;
let capturedCallCtx: CallContext | undefined;

beforeEach(() => {
  orig = { ..._executionDeps };
  origCaptureTreeState = _storyOrchestratorDeps.captureTreeState;
  capturedCallCtx = undefined;
  _executionDeps.getAgent = () => makeAgentAdapter({ name: "claude" });
  _executionDeps.validateAgentForTier = () => true;
  _executionDeps.captureGitRef = async () => "HEAD";
  _executionDeps.getUntrackedPaths = async () => [];
  _executionDeps.assemblePlanInputsFromCtx = async () => ({ story: makeStory(), config: makeNaxConfig() });
  _executionDeps.buildPlanForStrategy = async (callCtx: CallContext) => {
    capturedCallCtx = callCtx;
    return new ExecutionPlan(callCtx, {}, false);
  };
  _executionDeps.applyPostRunInspection = async () => ({
    agentResult: {
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCostUsd: 0,
    },
    selfVerificationFailed: false,
    needsHumanReview: false,
    combinedOutput: "",
  });
  _executionDeps.decideStageAction = async () => ({ action: "continue" });
  _storyOrchestratorDeps.captureTreeState = async () => ({ headSha: "test-head", dirtyDigest: "" });
});

afterEach(() => {
  Object.assign(_executionDeps, orig);
  _storyOrchestratorDeps.captureTreeState = origCaptureTreeState;
});

describe("execution stage — assembleStageBundle wiring (nax#1737 Phase B)", () => {
  test("CallContext carries an assembleStageBundle function", async () => {
    await executionStage.execute(makePipelineContext());

    expect(typeof capturedCallCtx?.assembleStageBundle).toBe("function");
  });

  test("calling assembleStageBundle delegates to _executionDeps.assembleForStage with the stage key", async () => {
    const bundle = makeContextBundle({ pushMarkdown: "## rectify bundle" });
    let receivedStage: string | undefined;
    _executionDeps.assembleForStage = async (_ctx, stage) => {
      receivedStage = stage;
      return bundle;
    };

    await executionStage.execute(makePipelineContext());
    const result = await capturedCallCtx?.assembleStageBundle?.("rectify");

    expect(receivedStage).toBe("rectify");
    expect(result).toBe(bundle);
  });

  test("assembleForStage returning null resolves to undefined, not null", async () => {
    _executionDeps.assembleForStage = async () => null;

    await executionStage.execute(makePipelineContext());
    const result = await capturedCallCtx?.assembleStageBundle?.("review-semantic");

    expect(result).toBeUndefined();
  });
});
