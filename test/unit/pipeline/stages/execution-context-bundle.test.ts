/**
 * nax#1737 Phase A — the execution stage must thread the assembled ContextBundle
 * onto the CallContext it builds.
 *
 * `CallContext.contextBundle` is what `callOp` passes to `runWithFallback` as the
 * initial `bundle`, and `buildHopCallback` gates BOTH the cross-agent
 * `rebuildForAgent` + swap-handoff prompt rewrite AND `createContextToolRuntime`
 * on it being present. No call site in src/ ever set it, so with #1722 making
 * swaps actually fire, a swapped-to agent inherited the primary's prompt verbatim
 * and `agent.fallback.rebuildContext` configured nothing.
 *
 * The stage already threads `contextToolRunCounter` — the counter for a tool
 * runtime that could never be constructed.
 *
 * [integration]: asserted through executionStage.execute(), not a hand-built
 * CallContext, because the defect was the stage's omission at the construction
 * point (src/pipeline/stages/execution.ts).
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

describe("execution stage — ContextBundle threading (nax#1737)", () => {
  test("AC1: the assembled bundle reaches CallContext.contextBundle", async () => {
    const bundle = makeContextBundle({ pushMarkdown: "## Feature context\nassembled" });

    await executionStage.execute(makePipelineContext({ contextBundle: bundle }));

    expect(capturedCallCtx?.contextBundle).toBe(bundle);
  });

  test("AC2: no assembled bundle leaves the field absent rather than set to undefined", async () => {
    await executionStage.execute(makePipelineContext());

    expect(capturedCallCtx).toBeDefined();
    expect("contextBundle" in (capturedCallCtx as object)).toBe(false);
  });
});
