import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { buildPlanForStrategy } from "@/execution/build-plan-for-strategy";
import type { PlanInputs } from "@/execution/plan-inputs";
import { _fullSuiteGateDeps } from "@/operations/full-suite-gate";
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
let origRunTests: typeof _fullSuiteGateDeps.runTests;

beforeEach(() => {
  saved = saveDeps();
  stubFullSuiteGateContext();
  origRunTests = _fullSuiteGateDeps.runTests;
});

afterEach(() => {
  restoreDeps(saved);
  _fullSuiteGateDeps.runTests = origRunTests;
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

function makePlanInputsNoGreenfield(storyArg: UserStory = story, overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    story: storyArg,
    config: DEFAULT_CONFIG,
    testWriter: { story: storyArg },
    implementer: { story: storyArg },
    fullSuiteGate: { story: storyArg, workdir: "/tmp/test" },
    verifier: { story: storyArg },
    ...overrides,
  };
}

describe("buildPlanForStrategy — failure scenarios", () => {
  test("test-writer failure → success=false", async () => {
    // Test-writer agent returns failure
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
      "three-session-tdd",
      makePlanInputsNoGreenfield(),
    );
    const result = await plan.run();

    expect(result.success).toBe(false);
  });

  test("test-writer crash/timeout → success=false", async () => {
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
      "three-session-tdd",
      makePlanInputsNoGreenfield(),
    );
    const result = await plan.run();

    expect(result.success).toBe(false);
  });

  test("implementer failure → success=false", async () => {
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts"], ["src/user.ts"], ["src/user.ts"]],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: false, exitCode: 1, estimatedCostUsd: 0.02 },
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

    expect(result.success).toBe(false);
  });

  test("success path → success=true", async () => {
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts"], ["src/user.ts"], ["src/user.ts"], ["src/user.ts"]],
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

  test("full-suite gate failure with verifier confirming failure → success=false", async () => {
    // SSOT semantic: verifier is authoritative. When BOTH the gate and verifier
    // flag failures, aggregation must reflect both. (The gate-fail-verifier-pass
    // unrelated-regression carve-out lives in story-orchestrator.test.ts.)
    _fullSuiteGateDeps.runTests = mock(async (_input, _ctx) => ({
      passed: false,
      failed: 1,
      output: "forced suite failure\n",
      timedOut: false,
      parsedSummary: {
        passed: 0,
        failed: 1,
        failures: [{ file: "test/a.test.ts", testName: "test A", error: "err A", stackTrace: [] }],
      },
    }));

    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts"], ["src/user.ts"], ["src/user.ts"]],
    });

    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: {
          ...DEFAULT_CONFIG.execution.rectification,
          enabled: true,
          maxAttemptsTotal: 2,
        },
      },
    };

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 }, // test-writer
      { success: true, estimatedCostUsd: 0.02 }, // implementer
      // Verifier explicitly reports failure — confirms the gate's verdict. Plain
      // `{ success: false }` would make the mock throw (treated as session error);
      // overriding `output` yields a parseable failure envelope instead.
      { output: JSON.stringify({ success: false, filesChanged: [] }), estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config });
    const callCtx = makeMockCallContext({ runtime });
    const inputs: PlanInputs = {
      story,
      config,
      testWriter: { story },
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
    };
    const plan = await buildPlanForStrategy(callCtx, story, config, "three-session-tdd", inputs);
    const result = await plan.run();

    expect(result.success).toBe(false);
  });

  test("zero-file scenario (greenfield) returns success=false when greenfieldGate is included", async () => {
    // BUG-010: Zero test files → greenfield-gate stops the pipeline
    // Need a real tmpDir for filesystem check
    const { mkdir, rm } = await import("node:fs/promises");
    const tmpDir = `/tmp/nax-fc-greenfield-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(tmpDir, { recursive: true });

    try {
      mockGitSpawn({
        diffFiles: [["requirements.md"], ["requirements.md"]],
      });

      const agent = createMockAgent([{ success: true, estimatedCostUsd: 0.01 }]);

      const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
      const callCtx = makeMockCallContext({ runtime });
      const inputs: PlanInputs = {
        story,
        config: DEFAULT_CONFIG,
        testWriter: { story },
        greenfieldGate: {
          story,
          workdir: tmpDir,
          resolvedTestPatterns: {
            globs: ["**/*.test.ts"],
            regex: [/\.test\.ts$/],
            pathspec: [":(exclude)**/*.test.ts"],
            testDirs: ["test/unit", "test/integration"],
            resolution: "fallback" as const,
          },
        },
        implementer: { story },
        fullSuiteGate: { story, workdir: tmpDir },
        verifier: { story },
      };
      const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", inputs);
      const result = await plan.run();

      expect(result.success).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
