/**
 * ACS-005: acceptance-setup stage — testStrategy wiring
 *
 * Tests that acceptance-setup reads testStrategy from config.acceptance.testStrategy
 * and passes it through to both the refinement module and the generator.
 *
 * These tests should FAIL until the implementer wires testStrategy through
 * the acceptance-setup stage.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "../../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { RefinementContext } from "../../../../src/acceptance/types";
import type { GenerateFromPRDOptions } from "../../../../src/acceptance/types";
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
    workdir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/nax/features/test-feature",
    hooks: {} as any,
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
// AC-6: acceptance-setup stage reads testStrategy from config.acceptance.testStrategy
// ─────────────────────────────────────────────────────────────────────────────

describe("acceptance-setup: reads testStrategy from config.acceptance.testStrategy", () => {
  test("passes testStrategy='component' from config to the refinement context", async () => {
    let capturedContext: RefinementContext | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (_criteria, context) => {
      capturedContext = context;
      return _criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    };
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'import { test } from "bun:test"; test("AC-1", () => {})',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({ testStrategy: "component", testFramework: "ink-testing-library" });
    await acceptanceSetupStage.execute(ctx);

    expect(capturedContext).not.toBeNull();
    expect((capturedContext as unknown as RefinementContext).testStrategy).toBe("component");
  });

  test("passes testStrategy='cli' from config to the refinement context", async () => {
    let capturedContext: RefinementContext | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (_criteria, context) => {
      capturedContext = context;
      return _criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    };
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'import { test } from "bun:test"; test("AC-1", () => {})',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({ testStrategy: "cli" });
    await acceptanceSetupStage.execute(ctx);

    expect(capturedContext).not.toBeNull();
    expect((capturedContext as unknown as RefinementContext).testStrategy).toBe("cli");
  });

  test("passes testStrategy=undefined to refinement context when not set in config", async () => {
    let capturedContext: RefinementContext | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (_criteria, context) => {
      capturedContext = context;
      return _criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    };
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'import { test } from "bun:test"; test("AC-1", () => {})',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx(); // no testStrategy in acceptance config
    await acceptanceSetupStage.execute(ctx);

    expect(capturedContext).not.toBeNull();
    expect((capturedContext as unknown as RefinementContext).testStrategy).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: acceptance-setup stage passes testStrategy to the generator
// ─────────────────────────────────────────────────────────────────────────────

describe("acceptance-setup: passes testStrategy to generator", () => {
  test("passes testStrategy='component' to generate options", async () => {
    let capturedOptions: GenerateFromPRDOptions | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (_criteria) =>
      _criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async (_stories, _refined, options) => {
      capturedOptions = options;
      return {
        testCode: 'import { test } from "bun:test"; test("AC-1", () => {})',
        criteria: [],
      };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({ testStrategy: "component", testFramework: "ink-testing-library" });
    await acceptanceSetupStage.execute(ctx);

    expect(capturedOptions).not.toBeNull();
    expect((capturedOptions as unknown as GenerateFromPRDOptions).testStrategy).toBe("component");
  });

  test("passes testFramework='ink-testing-library' to generate options when set in config", async () => {
    let capturedOptions: GenerateFromPRDOptions | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (_criteria) =>
      _criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async (_stories, _refined, options) => {
      capturedOptions = options;
      return {
        testCode: 'import { test } from "bun:test"; test("AC-1", () => {})',
        criteria: [],
      };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({ testStrategy: "component", testFramework: "ink-testing-library" });
    await acceptanceSetupStage.execute(ctx);

    expect(capturedOptions).not.toBeNull();
    expect((capturedOptions as unknown as GenerateFromPRDOptions).testFramework).toBe("ink-testing-library");
  });

  test("passes testStrategy='cli' to generate options", async () => {
    let capturedOptions: GenerateFromPRDOptions | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (_criteria) =>
      _criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async (_stories, _refined, options) => {
      capturedOptions = options;
      return {
        testCode: 'import { test } from "bun:test"; test("AC-1", () => {})',
        criteria: [],
      };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({ testStrategy: "cli" });
    await acceptanceSetupStage.execute(ctx);

    expect(capturedOptions).not.toBeNull();
    expect((capturedOptions as unknown as GenerateFromPRDOptions).testStrategy).toBe("cli");
  });

  test("testStrategy is undefined in generate options when not set in config", async () => {
    let capturedOptions: GenerateFromPRDOptions | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (_criteria) =>
      _criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async (_stories, _refined, options) => {
      capturedOptions = options;
      return {
        testCode: 'import { test } from "bun:test"; test("AC-1", () => {})',
        criteria: [],
      };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx(); // no testStrategy
    await acceptanceSetupStage.execute(ctx);

    expect(capturedOptions).not.toBeNull();
    expect((capturedOptions as unknown as GenerateFromPRDOptions).testStrategy).toBeUndefined();
  });

  test("passes testStrategy to both refine and generate in the same execution", async () => {
    let refineStrategy: string | undefined = "not-called";
    let generateStrategy: string | undefined = "not-called";

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (_criteria, context) => {
      refineStrategy = context.testStrategy;
      return _criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    };
    _acceptanceSetupDeps.generate = async (_stories, _refined, options) => {
      generateStrategy = options.testStrategy;
      return {
        testCode: 'import { test } from "bun:test"; test("AC-1", () => {})',
        criteria: [],
      };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({ testStrategy: "component", testFramework: "ink-testing-library" });
    await acceptanceSetupStage.execute(ctx);

    // Both refine and generate must receive the same testStrategy
    expect(refineStrategy).toBe("component");
    expect(generateStrategy).toBe("component");
  });

  test("passes testFramework to both refine and generate in the same execution", async () => {
    let refineFramework: string | undefined = "not-called";
    let generateFramework: string | undefined = "not-called";

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (_criteria, context) => {
      refineFramework = context.testFramework;
      return _criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    };
    _acceptanceSetupDeps.generate = async (_stories, _refined, options) => {
      generateFramework = options.testFramework;
      return {
        testCode: 'import { test } from "bun:test"; test("AC-1", () => {})',
        criteria: [],
      };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({ testStrategy: "component", testFramework: "ink-testing-library" });
    await acceptanceSetupStage.execute(ctx);

    expect(refineFramework).toBe("ink-testing-library");
    expect(generateFramework).toBe("ink-testing-library");
  });
});
