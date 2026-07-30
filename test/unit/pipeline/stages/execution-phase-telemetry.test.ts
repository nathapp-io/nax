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
import { executionStage, _executionDeps } from "@/pipeline";
import type { PipelineContext } from "@/pipeline/types";
import type { CallContext } from "@/operations/types";
import { makeMockAgentManager, makeNaxConfig, makeStory } from "@test/helpers";

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
    packageView: {} as any,
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      agent: "claude",
    },
    agentManager,
    sessionManager: {
      openSession: async () => ({ sessionId: "test-session" }) as any,
      sendPrompt: async () => ({ output: "test" }) as any,
      closeSession: async () => {},
      runInSession: async () => ({ output: "test" }) as any,
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

let orig: typeof _executionDeps;
let capturedCallCtx: CallContext | undefined;

beforeEach(() => {
  orig = { ..._executionDeps };
  capturedCallCtx = undefined;
  _executionDeps.getAgent = () =>
    ({ name: "claude", capabilities: { supportedTiers: ["fast", "balanced", "powerful"] } }) as any;
  _executionDeps.validateAgentForTier = () => true;
  _executionDeps.captureGitRef = async () => "HEAD";
  _executionDeps.assemblePlanInputsFromCtx = async () => ({}) as any;
  _executionDeps.buildPlanForStrategy = async (callCtx: CallContext) => {
    capturedCallCtx = callCtx;
    return { run: async () => ({ storyId: callCtx.storyId }) } as any;
  };
  _executionDeps.applyPostRunInspection = async () => ({}) as any;
  _executionDeps.decideStageAction = () => ({ action: "continue" }) as any;
});

afterEach(() => {
  Object.assign(_executionDeps, orig);
});

describe("execution stage — phaseTelemetry derivation (US-003 ACs 1-4)", () => {
  test("AC1/AC2: three-session-tdd derives sessionModel=three-session and forwards testStrategy unchanged", async () => {
    const ctx = makePipelineContext({ routing: { ...makePipelineContext().routing, testStrategy: "three-session-tdd" } });
    await executionStage.execute(ctx);
    expect(capturedCallCtx?.phaseTelemetry?.sessionModel).toBe("three-session");
    expect(capturedCallCtx?.phaseTelemetry?.testStrategy).toBe("three-session-tdd");
  });

  test("AC3: no-test derives sessionModel=single-session", async () => {
    const ctx = makePipelineContext({ routing: { ...makePipelineContext().routing, testStrategy: "no-test" } });
    await executionStage.execute(ctx);
    expect(capturedCallCtx?.phaseTelemetry?.sessionModel).toBe("single-session");
  });

  test("AC4: phaseTelemetry.tier equals the post-clamp effective tier, not the raw requested tier", async () => {
    _executionDeps.validateAgentForTier = () => false; // force the clamp path
    _executionDeps.getAgent = () => ({ name: "claude", capabilities: { supportedTiers: ["fast"] } }) as any;
    const ctx = makePipelineContext({ routing: { ...makePipelineContext().routing, modelTier: "powerful" } });
    await executionStage.execute(ctx);
    expect(capturedCallCtx?.phaseTelemetry?.tier).toBe("fast");
  });
});
