/**
 * ACS-005: acceptance-setup stage — testStrategy / testFramework wiring
 *
 * Tests verify:
 *   - callOp is invoked when testStrategy is set (stage completes without error)
 *   - testStrategy/testFramework/story context are forwarded to acceptance-refine op input
 *   - testFramework appears as frameworkOverrideLine in the generate callOp input
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "../../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { UserStory } from "../../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(id: string, acceptanceCriteria: string[]): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria,
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makePrd(stories: UserStory[]) {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeCtx(acceptanceOverrides: Record<string, unknown> = {}): PipelineContext {
  const stories = [
    makeStory("US-001", ["renders correctly", "shows expected output"]),
  ];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement: true,
        redGate: false,
        model: "fast",
        ...acceptanceOverrides,
      },
    } as any,
    prd: makePrd(stories),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-workdir",
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/nax/features/test-feature",
    hooks: {} as any,
  };
}

function makeDefaultCallOp() {
  return async (_ctx: any, _packageDir: any, op: any, input: any) => {
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") {
      return { testCode: 'import { test } from "bun:test"; test("AC-1", () => {})' };
    }
    throw new Error(`unexpected op: ${op.name}`);
  };
}

let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: testStrategy is internalized — callOp is invoked for all testStrategy values
// ─────────────────────────────────────────────────────────────────────────────

describe("acceptance-setup: testStrategy config is consumed (callOp invoked)", () => {
  function wireBasicDeps() {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
  }

  test("stage runs and calls callOp when testStrategy='component'", async () => {
    wireBasicDeps();
    let callOpCalled = false;
    const inner = _acceptanceSetupDeps.callOp;
    _acceptanceSetupDeps.callOp = async (ctx, pkg, op, input, storyId) => {
      callOpCalled = true;
      return inner(ctx, pkg, op, input, storyId);
    };

    const ctx = makeCtx({ testStrategy: "component", testFramework: "ink-testing-library" });
    await acceptanceSetupStage.execute(ctx);

    expect(callOpCalled).toBe(true);
  });

  test("stage runs and calls callOp when testStrategy='cli'", async () => {
    wireBasicDeps();
    let callOpCalled = false;
    const inner = _acceptanceSetupDeps.callOp;
    _acceptanceSetupDeps.callOp = async (ctx, pkg, op, input, storyId) => {
      callOpCalled = true;
      return inner(ctx, pkg, op, input, storyId);
    };

    const ctx = makeCtx({ testStrategy: "cli" });
    await acceptanceSetupStage.execute(ctx);

    expect(callOpCalled).toBe(true);
  });

  test("stage runs and calls callOp when testStrategy is not set in config", async () => {
    wireBasicDeps();
    let callOpCalled = false;
    const inner = _acceptanceSetupDeps.callOp;
    _acceptanceSetupDeps.callOp = async (ctx, pkg, op, input, storyId) => {
      callOpCalled = true;
      return inner(ctx, pkg, op, input, storyId);
    };

    const ctx = makeCtx(); // no testStrategy
    await acceptanceSetupStage.execute(ctx);

    expect(callOpCalled).toBe(true);
  });

  test("refine call receives strategy/framework/story context", async () => {
    wireBasicDeps();
    let capturedRefineInput:
      | {
          testStrategy?: string;
          testFramework?: string;
          storyTitle?: string;
          storyDescription?: string;
        }
      | undefined;

    _acceptanceSetupDeps.callOp = async (_ctx, _pkg, op, input) => {
      if (op.name === "acceptance-refine") {
        capturedRefineInput = input as typeof capturedRefineInput;
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'import { test } from "bun:test"; test("AC-1", () => {})' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };

    const ctx = makeCtx({ testStrategy: "component", testFramework: "ink-testing-library" });
    await acceptanceSetupStage.execute(ctx);

    expect(capturedRefineInput).toBeDefined();
    expect(capturedRefineInput?.testStrategy).toBe("component");
    expect(capturedRefineInput?.testFramework).toBe("ink-testing-library");
    expect(capturedRefineInput?.storyTitle).toBe("Story US-001");
    expect(capturedRefineInput?.storyDescription).toBe("desc");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: testFramework is passed as frameworkOverrideLine to the generate callOp
// ─────────────────────────────────────────────────────────────────────────────

describe("acceptance-setup: testFramework appears in generate callOp input", () => {
  function wireBasicDeps() {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
  }

  test("frameworkOverrideLine in generate input contains 'ink-testing-library' when set in config", async () => {
    let capturedFrameworkOverrideLine: string | undefined;
    wireBasicDeps();

    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        capturedFrameworkOverrideLine = (input as { frameworkOverrideLine: string }).frameworkOverrideLine;
        return { testCode: 'import { test } from "bun:test"; test("AC-1", () => {})' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };

    const ctx = makeCtx({ testStrategy: "component", testFramework: "ink-testing-library" });
    await acceptanceSetupStage.execute(ctx);

    expect(capturedFrameworkOverrideLine).toBeDefined();
    expect(capturedFrameworkOverrideLine!).toContain("ink-testing-library");
  });

  test("frameworkOverrideLine is empty string when testFramework is not set", async () => {
    let capturedFrameworkOverrideLine: string | undefined;
    wireBasicDeps();

    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        capturedFrameworkOverrideLine = (input as { frameworkOverrideLine: string }).frameworkOverrideLine;
        return { testCode: 'import { test } from "bun:test"; test("AC-1", () => {})' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };

    const ctx = makeCtx(); // no testFramework
    await acceptanceSetupStage.execute(ctx);

    expect(capturedFrameworkOverrideLine).toBe("");
  });

  test("acceptanceGenerateOp callOp receives storyId from first group story", async () => {
    wireBasicDeps();
    let capturedGenerateStoryId: string | undefined = "not-set";

    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input, storyId) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId: sid } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId: sid }));
      }
      if (op.name === "acceptance-generate") {
        capturedGenerateStoryId = storyId;
        return { testCode: 'import { test } from "bun:test"; test("AC-1", () => {})' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(capturedGenerateStoryId).toBe("US-001");
  });

  test("stage runs without error when both testStrategy and testFramework are set", async () => {
    wireBasicDeps();
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();

    const ctx = makeCtx({ testStrategy: "component", testFramework: "ink-testing-library" });
    await acceptanceSetupStage.execute(ctx);
    expect((ctx as any).acceptanceSetup).toBeDefined();
  });
});
