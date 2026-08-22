import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { buildPlanForStrategy } from "@/execution/build-plan-for-strategy";
import type { PlanInputs } from "@/execution/plan-inputs";
import type { UserStory } from "@/prd";
import { makeMockCallContext } from "@test/helpers";
import { makeRuntimeWithFakeAgent } from "@test/helpers";
import {
  type SavedDeps,
  createMockAgent,
  mockGitSpawn,
  restoreDeps,
  saveDeps,
  stubFullSuiteGateContext,
} from "./_tdd-test-helpers";

let saved: SavedDeps;

beforeEach(() => {
  saved = saveDeps();
  stubFullSuiteGateContext();
});

afterEach(() => {
  restoreDeps(saved);
});

const story: UserStory = {
  id: "US-001",
  title: "Add user validation",
  description: "Add validation to user input",
  acceptanceCriteria: ["Validation works", "Errors are clear"],
  dependencies: [],
  tags: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};

function makePlanInputsNoGreenfield(storyArg: UserStory = story): PlanInputs {
  return {
    story: storyArg,
    config: DEFAULT_CONFIG,
    testWriter: { story: storyArg },
    implementer: { story: storyArg },
    fullSuiteGate: { story: storyArg, workdir: "/tmp/test" },
    verifier: { story: storyArg },
  };
}

describe("buildPlanForStrategy — three-session-tdd-lite strategy", () => {
  test("lite strategy: all 3 sessions succeed → success", async () => {
    // Lite strategy uses 'three-session-tdd-lite' — same phases as three-session-tdd
    // (lite mode skipping of isolation checks is handled inside assembleTddSessionResult in session-op.ts)
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["src/user.ts"], [], ["src/user.ts"]],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(
      callCtx,
      story,
      DEFAULT_CONFIG,
      "three-session-tdd-lite",
      makePlanInputsNoGreenfield(),
    );
    const result = await plan.run();

    expect(result.success).toBe(true);
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });

  test("strict strategy: all 3 sessions succeed → success", async () => {
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts"], ["src/user.ts"], ["src/user.ts"], [], ["src/user.ts"]],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(
      callCtx,
      story,
      DEFAULT_CONFIG,
      "three-session-tdd",
      makePlanInputsNoGreenfield(),
    );
    const result = await plan.run();

    expect(result.success).toBe(true);
  });

  test("lite strategy: implementer modifying test files still succeeds", async () => {
    // In lite mode isolation is skipped; this test verifies the agent result drives success
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts", "src/user.ts"], [], []],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(
      callCtx,
      story,
      DEFAULT_CONFIG,
      "three-session-tdd-lite",
      makePlanInputsNoGreenfield(),
    );
    const result = await plan.run();

    expect(result.success).toBe(true);
  });

  test("lite strategy: test-writer failure → success=false", async () => {
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts"]],
    });

    const agent = createMockAgent([{ success: false, exitCode: 1, estimatedCostUsd: 0.01 }]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(
      callCtx,
      story,
      DEFAULT_CONFIG,
      "three-session-tdd-lite",
      makePlanInputsNoGreenfield(),
    );
    const result = await plan.run();

    expect(result.success).toBe(false);
  });

  test("lite strategy: phaseOutputs includes all TDD phases", async () => {
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["src/user.ts"], [], ["src/user.ts"]],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(
      callCtx,
      story,
      DEFAULT_CONFIG,
      "three-session-tdd-lite",
      makePlanInputsNoGreenfield(),
    );
    const result = await plan.run();

    expect("test-writer" in result.phaseOutputs).toBe(true);
    expect("implementer" in result.phaseOutputs).toBe(true);
    expect("verifier" in result.phaseOutputs).toBe(true);
  });
});
