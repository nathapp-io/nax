import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeMockCallContext, makeRuntimeWithFakeAgent, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { buildPlanForStrategy } from "@/execution/build-plan-for-strategy";
import type { PlanInputs } from "@/execution/plan-inputs";
import type { UserStory } from "@/prd";
import type { ResolvedTestPatterns } from "@/test-runners";
import {
  createMockAgent,
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

function _makePlanInputsNoGreenfield(storyArg: UserStory = story): PlanInputs {
  return {
    story: storyArg,
    config: DEFAULT_CONFIG,
    testWriter: { story: storyArg },
    implementer: { story: storyArg },
    fullSuiteGate: { story: storyArg, workdir: "/tmp/test" },
    verifier: { story: storyArg },
  };
}

describe("buildPlanForStrategy — zero-file greenfield scenarios", () => {
  test("zero-file scenario returns success=false when greenfield gate is configured", async () => {
    // BUG-010: Zero test files → greenfield-gate stops the pipeline. No auto-fallback occurs.
    const tmpDir = makeTempDir("nax-fallback-");

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
        greenfieldGate: { story, workdir: tmpDir, resolvedTestPatterns: defaultPatterns() },
        implementer: { story },
        fullSuiteGate: { story, workdir: tmpDir },
        verifier: { story },
      };
      const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", inputs);
      const result = await plan.run();

      // Greenfield gate stops the plan; no auto-fallback to lite mode
      expect(result.success).toBe(false);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  test("lite strategy with zero-file scenario also returns success=false", async () => {
    const tmpDir = makeTempDir("nax-fallback-lite-");

    try {
      mockGitSpawn({
        diffFiles: [["requirements.md"]],
      });

      const agent = createMockAgent([{ success: true, estimatedCostUsd: 0.01 }]);

      const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
      const callCtx = makeMockCallContext({ runtime });
      const inputs: PlanInputs = {
        story,
        config: DEFAULT_CONFIG,
        testWriter: { story },
        greenfieldGate: { story, workdir: tmpDir, resolvedTestPatterns: defaultPatterns() },
        implementer: { story },
        fullSuiteGate: { story, workdir: tmpDir },
        verifier: { story },
      };
      const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd-lite", inputs);
      const result = await plan.run();

      expect(result.success).toBe(false);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  test("strict strategy: no test files → success=false (no fallback)", async () => {
    const tmpDir = makeTempDir("nax-fallback-strict-");

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
        greenfieldGate: { story, workdir: tmpDir, resolvedTestPatterns: defaultPatterns() },
        implementer: { story },
        fullSuiteGate: { story, workdir: tmpDir },
        verifier: { story },
      };
      const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", inputs);
      const result = await plan.run();

      expect(result.success).toBe(false);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  test("when pre-existing test files exist, greenfield gate passes and plan succeeds", async () => {
    // Create a temp dir WITH an actual test file so greenfield check passes
    const tmpDir = makeTempDir("nax-fallback-existing-");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(`${tmpDir}/test`, { recursive: true });
    await writeFile(`${tmpDir}/test/user.test.ts`, "// placeholder test file");

    try {
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
      const inputs: PlanInputs = {
        story,
        config: DEFAULT_CONFIG,
        testWriter: { story },
        greenfieldGate: { story, workdir: tmpDir, resolvedTestPatterns: defaultPatterns() },
        implementer: { story },
        fullSuiteGate: { story, workdir: tmpDir },
        verifier: { story },
      };
      const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", inputs);
      const result = await plan.run();

      // Pre-existing tests found → greenfield gate passes → plan succeeds
      expect(result.success).toBe(true);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
