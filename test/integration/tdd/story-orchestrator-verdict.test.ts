import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeMockCallContext, makeRuntimeWithFakeAgent } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { buildPlanForStrategy } from "@/execution/build-plan-for-strategy";
import type { PlanInputs } from "@/execution/plan-inputs";
import type { UserStory } from "@/prd";
import type { ResolvedTestPatterns } from "@/test-runners";
import {
  createMockAgent,
  mockAllSpawn,
  mockGitSpawn,
  restoreDeps,
  type SavedDeps,
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

function defaultPatterns(): ResolvedTestPatterns {
  return {
    globs: ["**/*.test.ts"],
    regex: [/\.test\.ts$/],
    pathspec: [":(exclude)**/*.test.ts"],
    testDirs: ["test/unit", "test/integration"],
    resolution: "detected",
  };
}

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

/**
 * Mock git + optional test command for a full 3-session run.
 */
function mockGitAndTest(opts: { diffFiles?: string[][]; onTestCmd?: () => { exitCode: number; stdout: string } }) {
  const files = opts.diffFiles ?? [
    ["test/user.test.ts"],
    ["test/user.test.ts"],
    ["src/user.ts"],
    ["src/user.ts"],
    [],
    ["src/user.ts"],
  ];
  let revParseCount = 0;
  let diffCount = 0;

  mockAllSpawn(
    mock((cmd: string[]) => {
      if (cmd[0] === "/bin/sh" && cmd[2]?.includes("bun test")) {
        const r = opts.onTestCmd?.() ?? { exitCode: 0, stdout: "5 pass, 0 fail\n" };
        return {
          pid: 9999,
          exited: Promise.resolve(r.exitCode),
          stdout: new Response(r.stdout).body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        revParseCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(`ref-${revParseCount}\n`).body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "diff") {
        const f = files[diffCount] || [];
        diffCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(`${f.join("\n")}\n`).body,
          stderr: new Response("").body,
        };
      }
      return { exited: Promise.resolve(0), stdout: new Response("").body, stderr: new Response("").body };
    }),
  );
}

describe("buildPlanForStrategy — three-session-tdd verdict", () => {
  test("all sessions succeed → result.success is true", async () => {
    mockGitAndTest({});

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

  test("verifier session fails → result.success is false", async () => {
    mockGitAndTest({});

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: false, exitCode: 1, estimatedCostUsd: 0.01 },
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

  test("no test command configured → sessions still complete successfully", async () => {
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts"], ["src/user.ts"], ["src/user.ts"], ["src/user.ts"]],
    });

    const configNoRectification = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: { ...DEFAULT_CONFIG.execution.rectification, enabled: false },
      },
    };

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: configNoRectification });
    const callCtx = makeMockCallContext({ runtime });
    const inputs: PlanInputs = {
      story,
      config: configNoRectification,
      testWriter: { story },
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
    };
    const plan = await buildPlanForStrategy(callCtx, story, configNoRectification, "three-session-tdd", inputs);
    const result = await plan.run();

    expect(result.success).toBe(true);
  });

  test("early-exit before session 3 (session 1 fails) → result.success is false", async () => {
    mockGitAndTest({
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

  test("phaseOutputs contains implementer key after successful run", async () => {
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

    expect(result.phaseOutputs).toBeDefined();
    expect("implementer" in result.phaseOutputs).toBe(true);
    expect("verifier" in result.phaseOutputs).toBe(true);
  });
});
