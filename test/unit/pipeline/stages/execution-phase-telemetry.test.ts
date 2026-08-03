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
import type { CallContext } from "@/operations/types";
import { _executionDeps, executionStage } from "@/pipeline";
import type { PipelineContext } from "@/pipeline/types";
import { makeAgentAdapter, makeMockAgentManager, makeNaxConfig, makeStory } from "@test/helpers";

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
  _executionDeps.getAgent = () => makeAgentAdapter({ name: "claude" });
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
    const ctx = makePipelineContext({
      routing: { ...makePipelineContext().routing, testStrategy: "three-session-tdd" },
    });
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
    const defaultCapabilities = makeAgentAdapter().capabilities;
    _executionDeps.getAgent = () =>
      makeAgentAdapter({
        name: "claude",
        capabilities: {
          ...defaultCapabilities,
          supportedTiers: ["fast"],
        },
      });
    const ctx = makePipelineContext({ routing: { ...makePipelineContext().routing, modelTier: "powerful" } });
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
    (ctx as unknown as { contextToolRunCounter: unknown }).contextToolRunCounter = counter;

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
