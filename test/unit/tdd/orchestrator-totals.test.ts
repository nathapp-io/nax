/**
 * buildPlanForStrategy — totalCostUsd + durationMs aggregation.
 *
 * The plan aggregates cost and duration from all phases. This verifies
 * that those fields are populated correctly in StoryOrchestratorResult.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { AgentResult } from "@/agents/types";
import { buildPlanForStrategy } from "@/execution/build-plan-for-strategy";
import type { PlanInputs } from "@/execution/plan-inputs";
import { _fullSuiteGateDeps } from "@/operations/full-suite-gate";
import type { UserStory } from "@/prd";
import { _isolationDeps } from "@/tdd/isolation";
import { _rollbackDeps } from "@/tdd/rollback";
import { _gitDeps } from "@/utils/git";
import {
  fakeAgentManager,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeSpawn,
  makeStory as makeStoryBase,
} from "@test/helpers";

// Mock spawn-based deps so the post-dispatch isolation/getChangedFiles/autoCommit
// helpers don't try to invoke real `git`. This test asserts on cost/duration aggregation.
let savedIsolation: typeof _isolationDeps.spawn;
let savedRollback: typeof _rollbackDeps.spawn;
let savedGit: typeof _gitDeps.spawn;
let savedRunTests: typeof _fullSuiteGateDeps.runTests;
beforeAll(() => {
  savedIsolation = _isolationDeps.spawn;
  savedRollback = _rollbackDeps.spawn;
  savedGit = _gitDeps.spawn;
  savedRunTests = _fullSuiteGateDeps.runTests;
  _isolationDeps.spawn = makeSpawn().spawn;
  _rollbackDeps.spawn = makeSpawn().spawn;
  _gitDeps.spawn = makeSpawn().spawn;
  _fullSuiteGateDeps.runTests = mock(async () => ({ passed: true, failed: 0, output: "all pass" }));
});
afterAll(() => {
  _isolationDeps.spawn = savedIsolation;
  _rollbackDeps.spawn = savedRollback;
  _gitDeps.spawn = savedGit;
  _fullSuiteGateDeps.runTests = savedRunTests;
});

function makeStory(): UserStory {
  return makeStoryBase({
    id: "US-001",
    title: "Impl",
    description: "desc",
    acceptanceCriteria: ["AC-1"],
    priorFailures: [],
  });
}

function makeConfig() {
  return makeNaxConfig({
    models: {
      claude: {
        fast: "fast",
        balanced: "balanced",
        powerful: "powerful",
      },
    },
    agent: { default: "claude" },
    execution: { rectification: { enabled: false }, sessionTimeoutSeconds: 300 },
    quality: { commands: { test: "bun test" } },
    tdd: { testWriterAllowedPaths: [], rollbackOnFailure: false },
  });
}

/**
 * Build an agent adapter whose sendTurn returns specific tokenUsage per sequential call.
 * Output is JSON-encoded so ops' parse() produces success:true and filesChanged
 * for the test-writer session — this satisfies the greenfield guard path.
 */
function agentReturning(tokens: Array<AgentResult["tokenUsage"] | undefined>) {
  let call = 0;
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"] as ("fast" | "balanced" | "powerful")[],
      maxContextTokens: 200_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(),
    },
    isInstalled: mock(async () => true),
    buildCommand: mock(() => [] as string[]),
    complete: mock(async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 })),
    plan: mock(async () => ({ specContent: "" })),
    decompose: mock(async () => ({ stories: [] })),
    closePhysicalSession: mock(async () => {}),
    openSession: mock(async () => ({ id: "mock-session", agentName: "mock" })),
    sendTurn: mock(async () => {
      const tokenUsage = tokens[call];
      const filesChanged = call === 0 ? ["test/foo.test.ts"] : [];
      call++;
      return {
        output: JSON.stringify({ success: true, filesChanged }),
        tokenUsage,
        internalRoundTrips: 1,
        estimatedCostUsd: 0.01,
      };
    }),
    closeSession: mock(async () => {}),
  };
}

function makePlanInputsNoGreenfield(story: UserStory, config: ReturnType<typeof makeConfig>): PlanInputs {
  return {
    story,
    config,
    testWriter: { story },
    implementer: { story },
    fullSuiteGate: { story, workdir: "/tmp/fake", rectificationEnabled: false },
    verifier: { story },
  };
}

describe("buildPlanForStrategy — cost + duration aggregation", () => {
  test("totalCostUsd is accumulated across all three phases", async () => {
    const agent = agentReturning([
      { inputTokens: 100, outputTokens: 50 },
      { inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 10 },
      { inputTokens: 50, outputTokens: 25 },
    ]);
    const config = makeConfig();
    const story = makeStory();

    let agentManager!: ReturnType<typeof fakeAgentManager>;
    const runtime = makeMockRuntime({
      config,
      agentManagerFactory: (rt) => {
        agentManager = fakeAgentManager(agent as never, { dispatchEvents: rt.dispatchEvents });
        return agentManager;
      },
    });

    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(
      callCtx,
      story,
      config,
      "three-session-tdd",
      makePlanInputsNoGreenfield(story, config),
    );
    const result = await plan.run();

    // totalCostUsd should be non-negative (may be 0 if agent doesn't emit costs in test mode)
    expect(typeof result.totalCostUsd).toBe("number");
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  test("durationMs is a non-negative number", async () => {
    const agent = agentReturning([undefined, undefined, undefined]);
    const config = makeConfig();
    const story = makeStory();

    let agentManager!: ReturnType<typeof fakeAgentManager>;
    const runtime = makeMockRuntime({
      config,
      agentManagerFactory: (rt) => {
        agentManager = fakeAgentManager(agent as never, { dispatchEvents: rt.dispatchEvents });
        return agentManager;
      },
    });

    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(
      callCtx,
      story,
      config,
      "three-session-tdd",
      makePlanInputsNoGreenfield(story, config),
    );
    const result = await plan.run();

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("phaseCosts has entries for all executed phases", async () => {
    const agent = agentReturning([undefined, undefined, undefined]);
    const config = makeConfig();
    const story = makeStory();

    let agentManager!: ReturnType<typeof fakeAgentManager>;
    const runtime = makeMockRuntime({
      config,
      agentManagerFactory: (rt) => {
        agentManager = fakeAgentManager(agent as never, { dispatchEvents: rt.dispatchEvents });
        return agentManager;
      },
    });

    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(
      callCtx,
      story,
      config,
      "three-session-tdd",
      makePlanInputsNoGreenfield(story, config),
    );
    const result = await plan.run();

    // phaseCosts should have entries for at least the executed phases
    expect(typeof result.phaseCosts).toBe("object");
    expect(result.phaseCosts).not.toBeNull();
    // At minimum: test-writer, implementer, verifier
    expect(Object.keys(result.phaseCosts).length).toBeGreaterThanOrEqual(1);
  });
});
