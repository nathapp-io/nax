/**
 * ADR-030 (amended for P4): the execution stage marks its ask resolver with
 * whether a human can be reached, so an `escalate` Bash description can say
 * so -- and must NOT say so when no interaction channel exists (a headless CLI
 * run resolves every ask to `unavailable`).
 *
 * [integration]: asserted through executionStage.execute(), because the
 * reachability decision is made at the resolver's construction point
 * (src/pipeline/stages/execution.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeAgentAdapter, makeNaxConfig, makeStory, makeTestContext } from "@test/helpers";
import type { CommandShadow } from "@/command-safety";
import type { ConfigSelector } from "@/config";
import { _storyOrchestratorDeps, ExecutionPlan } from "@/execution";
import { InteractionChain } from "@/interaction";
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
    agentResult: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 },
    selfVerificationFailed: false,
    needsHumanReview: false,
    providerUnavailable: false,
    combinedOutput: "",
  });
  _executionDeps.decideStageAction = async () => ({ action: "continue" });
  _storyOrchestratorDeps.captureTreeState = async () => ({ headSha: "test-head", dirtyDigest: "" });
});

afterEach(() => {
  Object.assign(_executionDeps, orig);
  _storyOrchestratorDeps.captureTreeState = origCaptureTreeState;
});

describe("execution stage — ask resolver reachability", () => {
  test("an interaction chain present marks the resolver humanReachable", async () => {
    _executionDeps.stdinIsTTY = () => true; // default plugin is cli; see the cli tests below
    const interaction = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });
    await executionStage.execute(makePipelineContext({ interaction }));
    expect(capturedCallCtx?.askResolver?.humanReachable).toBe(true);
  });

  test("the cli plugin without a TTY stdin cannot be answered, so it is unreachable", async () => {
    _executionDeps.stdinIsTTY = () => false;
    const config = makeNaxConfig({ interaction: { plugin: "cli" } });
    const interaction = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });
    await executionStage.execute(makePipelineContext({ interaction, config }));
    expect(capturedCallCtx?.askResolver?.humanReachable).toBe(false);
  });

  test("the cli plugin with a TTY stdin is reachable; a non-cli plugin ignores stdin", async () => {
    const interaction = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });
    _executionDeps.stdinIsTTY = () => true;
    const cli = makeNaxConfig({ interaction: { plugin: "cli" } });
    await executionStage.execute(makePipelineContext({ interaction, config: cli }));
    expect(capturedCallCtx?.askResolver?.humanReachable).toBe(true);
    _executionDeps.stdinIsTTY = () => false;
    const telegram = makeNaxConfig({ interaction: { plugin: "telegram" } });
    await executionStage.execute(makePipelineContext({ interaction, config: telegram }));
    expect(capturedCallCtx?.askResolver?.humanReachable).toBe(true);
  });

  test("no interaction chain (headless CLI, unconfigured) marks it unreachable", async () => {
    await executionStage.execute(makePipelineContext());
    expect(capturedCallCtx?.askResolver?.humanReachable).toBe(false);
  });
});

function spyShadow() {
  const calls = { drained: 0 };
  const shadow: CommandShadow = { observe: () => {}, settle: () => {}, drain: async () => void calls.drained++ };
  return { shadow, calls };
}

describe("execution stage — command shadow", () => {
  test("no commandSafety config: nothing is built or threaded", async () => {
    await executionStage.execute(makePipelineContext());
    expect(capturedCallCtx?.commandShadow).toBeUndefined();
  });

  test("the built shadow reaches the CallContext and is drained after the plan", async () => {
    const spy = spyShadow();
    const seen: unknown[] = [];
    _executionDeps.buildCommandShadow = (opts) => {
      seen.push(opts);
      return spy.shadow;
    };
    const config = makeNaxConfig({ execution: { commandSafety: { shadow: { url: "http://127.0.0.1:1/x" } } } });
    await executionStage.execute(makePipelineContext({ config }));
    expect(capturedCallCtx?.commandShadow).toBe(spy.shadow);
    expect(spy.calls.drained).toBe(1);
    expect(seen[0]).toMatchObject({ runId: expect.any(String), storyId: expect.any(String) });
  });

  test("drained even when the plan throws", async () => {
    const spy = spyShadow();
    _executionDeps.buildCommandShadow = () => spy.shadow;
    _executionDeps.buildPlanForStrategy = async (callCtx: CallContext) => {
      capturedCallCtx = callCtx;
      const plan = new ExecutionPlan(callCtx, {}, false);
      plan.run = async () => {
        throw new Error("plan failed");
      };
      return plan;
    };
    await expect(executionStage.execute(makePipelineContext())).rejects.toThrow("plan failed");
    expect(spy.calls.drained).toBe(1);
  });
});
