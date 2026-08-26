/**
 * Execution stage — `phaseTelemetry` derivation (US-003 ACs 1-4)
 *
 * These ACs are explicitly [integration]: they require running the execution
 * stage itself (not a hand-built CallContext) to prove sessionModel /
 * testStrategy / tier are derived from ctx.routing at the real emission
 * point (src/pipeline/stages/execution.ts), not merely forwarded by a
 * downstream consumer. Intercepts `_executionDeps.buildPlanForStrategy` —
 * the first call site to receive the constructed `callCtx` — to capture the
 * phaseTelemetry slice without needing to run a real plan.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeAgentAdapter, makeNaxConfig, makeStory, makeTestContext } from "@test/helpers";
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

function makePipelineContext(routingOverrides: Partial<RoutingResult> = {}): PipelineContext {
  const config = makeNaxConfig();
  return makeTestContext({
    config,
    rootConfig: config,
    routing: { ...BASE_ROUTING, ...routingOverrides },
    packageView: {
      packageDir: "/tmp/test",
      relativeFromRoot: "",
      repoRoot: "/tmp/test",
      hasOverride: false,
      config,
      select: <C>(selector: ConfigSelector<C>) => selector.select(config),
    },
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

describe("execution stage — phaseTelemetry derivation (US-003 ACs 1-4)", () => {
  test("AC1/AC2: three-session-tdd derives sessionModel=three-session and forwards testStrategy unchanged", async () => {
    const ctx = makePipelineContext({ testStrategy: "three-session-tdd" });
    await executionStage.execute(ctx);
    expect(capturedCallCtx?.phaseTelemetry?.sessionModel).toBe("three-session");
    expect(capturedCallCtx?.phaseTelemetry?.testStrategy).toBe("three-session-tdd");
  });

  test("AC3: no-test derives sessionModel=single-session", async () => {
    const ctx = makePipelineContext({ testStrategy: "no-test" });
    await executionStage.execute(ctx);
    expect(capturedCallCtx?.phaseTelemetry?.sessionModel).toBe("single-session");
  });

  test("AC4: phaseTelemetry.tier equals the post-clamp effective tier, not the raw requested tier", async () => {
    _executionDeps.validateAgentForTier = () => false; // force the clamp path
    const defaultCapabilities = makeAgentAdapter().capabilities;
    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "claude",
        capabilities: {
          ...defaultCapabilities,
          supportedTiers: ["fast"],
        },
      });
    const ctx = makePipelineContext({ modelTier: "powerful" });
    await executionStage.execute(ctx);
    expect(capturedCallCtx?.phaseTelemetry?.tier).toBe("fast");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap finding 7 / AC-18. This one line in the callCtx literal is the only edge
// connecting the counter the context stage creates to the call path that uses
// it. Delete it and the whole pull-telemetry feature is inert in production —
// metrics permanently absent, the cap back to per-hop — while every other test
// in the suite stays green. That is the same declared-but-never-populated
// pattern the feature exists to fix, so it gets its own guard.
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — contextToolRunCounter threading (AC-18)", () => {
  test("forwards the SAME counter object from PipelineContext onto CallContext", async () => {
    const counter = { count: 0, calls: [] };
    const ctx = makePipelineContext();
    ctx.contextToolRunCounter = counter;

    await executionStage.execute(ctx);

    // Identity, not equality: a copy would leave collectStoryMetrics reading an
    // empty array while every unit test still passed.
    expect(capturedCallCtx?.contextToolRunCounter).toBe(counter);
  });

  test("omits the field entirely when the context stage never created a counter", async () => {
    await executionStage.execute(makePipelineContext());
    expect(capturedCallCtx?.contextToolRunCounter).toBeUndefined();
  });
});
