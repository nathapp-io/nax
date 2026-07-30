/**
 * Tests for bus event emission in acceptance-setup stage (US-004)
 *
 * AC1: emits postrun:phase:started with phase "acceptance-setup" before generation
 * AC2: emits postrun:phase:completed with passed:true even when RED gate fails
 * AC3: details totalCriteria, testableCount, redFailCount equal recorded stage values
 * AC4: emits completed even when all acceptance tests already pass (stage skips)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  acceptanceSetupStage,
  _acceptanceSetupDeps,
  pipelineEventBus,
} from "@/pipeline";
import type { PipelineContext } from "@/pipeline";
import type {
  PostRunPhaseStartedEvent,
  PostRunPhaseCompletedEvent,
} from "@/pipeline";
import { DEFAULT_CONFIG } from "@/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, criteria: string[]) {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria: criteria,
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makePrd(stories: ReturnType<typeof makeStory>[]) {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

// Default context: 3 total criteria across 2 stories, no refinement
function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [
    makeStory("US-001", ["AC-1: first criterion", "AC-2: second criterion"]),
    makeStory("US-002", ["AC-1: third criterion"]),
  ];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement: false,
        redGate: true,
        model: "fast",
      },
    } as PipelineContext["config"],
    prd: makePrd(stories),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-acceptance-events",
    projectDir: "/tmp/test-acceptance-events",
    featureDir: "/tmp/test-acceptance-events/.nax/features/test-feature",
    hooks: {} as PipelineContext["hooks"],
    ...overrides,
  };
}

/** Wire all injectable deps so execute() can reach the bus-emit point. */
function wireDeps(runTestExitCode: number) {
  _acceptanceSetupDeps.fileExists = async () => false;
  _acceptanceSetupDeps.readMeta = async () => null;
  _acceptanceSetupDeps.deleteSemanticVerdicts = async () => {};
  _acceptanceSetupDeps.copyFile = async () => {};
  _acceptanceSetupDeps.deleteFile = async () => {};
  _acceptanceSetupDeps.writeMeta = async () => {};
  _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
  _acceptanceSetupDeps.loadGroupConfig = async () => DEFAULT_CONFIG as PipelineContext["config"];
  _acceptanceSetupDeps.writeFile = async () => {};
  _acceptanceSetupDeps.callOp = async (_ctx, _pkg, op, input) => {
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") {
      return { testCode: 'test("AC-1", () => { throw new Error("red") })' };
    }
    throw new Error(`unexpected op: ${(op as { name: string }).name}`);
  };
  _acceptanceSetupDeps.runTest = async () => ({
    exitCode: runTestExitCode,
    output: runTestExitCode !== 0 ? "1 fail" : "all pass",
  });
}

let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
  pipelineEventBus.clear();
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  pipelineEventBus.clear();
});

// ---------------------------------------------------------------------------
// AC1: postrun:phase:started with phase "acceptance-setup" before generation
// ---------------------------------------------------------------------------

describe("acceptance-setup events — AC1: postrun:phase:started before generation", () => {
  test("AC1: emits postrun:phase:started with phase 'acceptance-setup'", async () => {
    const started: PostRunPhaseStartedEvent[] = [];
    pipelineEventBus.on("postrun:phase:started", (e) => { started.push(e); });

    wireDeps(1);
    await acceptanceSetupStage.execute(makeCtx());

    const acceptSetupStarted = started.filter((e) => e.phase === "acceptance-setup");
    expect(acceptSetupStarted.length).toBeGreaterThan(0);
    expect(acceptSetupStarted[0].phase).toBe("acceptance-setup");
  });

  test("AC1: started event fires before callOp (before generation)", async () => {
    const callOrder: string[] = [];

    pipelineEventBus.on("postrun:phase:started", (e) => {
      if (e.phase === "acceptance-setup") callOrder.push("started");
    });
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.deleteSemanticVerdicts = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
    _acceptanceSetupDeps.loadGroupConfig = async () => DEFAULT_CONFIG as PipelineContext["config"];
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "fail" });
    _acceptanceSetupDeps.callOp = async (_ctx, _pkg, op, _input) => {
      callOrder.push("callOp");
      if (op.name === "acceptance-generate") return { testCode: 'test("x", () => {})' };
      throw new Error(`unexpected op: ${(op as { name: string }).name}`);
    };

    await acceptanceSetupStage.execute(makeCtx());

    const startedIdx = callOrder.indexOf("started");
    const callOpIdx = callOrder.indexOf("callOp");
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(startedIdx).toBeLessThan(callOpIdx);
  });

  test("AC1 boundary: no started event emitted when featureDir is absent", async () => {
    const started: PostRunPhaseStartedEvent[] = [];
    pipelineEventBus.on("postrun:phase:started", (e) => {
      if (e.phase === "acceptance-setup") started.push(e);
    });

    await acceptanceSetupStage.execute(makeCtx({ featureDir: undefined }));

    expect(started.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC2: postrun:phase:completed with passed:true when RED gate fails
// ---------------------------------------------------------------------------

describe("acceptance-setup events — AC2: completed passed:true on RED-gate failure", () => {
  test("AC2: emits postrun:phase:completed with passed:true when exit code != 0", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    wireDeps(1); // exit 1 = RED gate fails (valid RED, stage continues)
    await acceptanceSetupStage.execute(makeCtx());

    expect(completed.length).toBeGreaterThan(0);
    expect(completed[0].passed).toBe(true);
  });

  test("AC2: completed event is emitted exactly once per execute call", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    wireDeps(1);
    await acceptanceSetupStage.execute(makeCtx());

    expect(completed.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC3: details totalCriteria, testableCount, redFailCount equal stage values
// ---------------------------------------------------------------------------

describe("acceptance-setup events — AC3: details match recorded stage values", () => {
  test("AC3: details.totalCriteria equals sum of ACs across all non-fix stories", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    wireDeps(1);
    await acceptanceSetupStage.execute(makeCtx()); // 3 total criteria

    const details = completed[0]?.details as Record<string, unknown> | undefined;
    expect(details?.totalCriteria).toBe(3);
  });

  test("AC3: details.testableCount equals criteria marked testable by refinement", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    // Use refinement=true so testableCount is driven by refinement output
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.deleteSemanticVerdicts = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
    _acceptanceSetupDeps.loadGroupConfig = async () => DEFAULT_CONFIG as PipelineContext["config"];
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "fail" });
    // US-001 testable, US-002 not testable → testableCount = 2
    _acceptanceSetupDeps.callOp = async (_ctx, _pkg, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: storyId === "US-001", storyId }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("x", () => { throw new Error("red") })' };
      }
      throw new Error(`unexpected op: ${(op as { name: string }).name}`);
    };

    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: true, redGate: true, model: "fast" },
      } as PipelineContext["config"],
    });
    await acceptanceSetupStage.execute(ctx);

    const details = completed[0]?.details as Record<string, unknown> | undefined;
    expect(details?.testableCount).toBe(2);
  });

  test("AC3: details.redFailCount equals number of packages where test exit != 0", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    wireDeps(1); // one package, exit code 1 → redFailCount = 1
    await acceptanceSetupStage.execute(makeCtx());

    const details = completed[0]?.details as Record<string, unknown> | undefined;
    expect(details?.redFailCount).toBe(1);
  });

  test("AC3: details.regenerated is true when test file was generated this run", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    wireDeps(1); // readMeta returns null → shouldGenerate = true → regenerated
    await acceptanceSetupStage.execute(makeCtx());

    const details = completed[0]?.details as Record<string, unknown> | undefined;
    expect(details?.regenerated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4: completed event still emitted when all tests already pass (stage skips)
// ---------------------------------------------------------------------------

describe("acceptance-setup events — AC4: completed emitted when stage skips", () => {
  test("AC4: emits postrun:phase:completed when all acceptance tests already pass", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    wireDeps(0); // exit 0 = tests already pass → stage returns skip
    const result = await acceptanceSetupStage.execute(makeCtx());

    expect(result.action).toBe("skip");
    expect(completed.length).toBeGreaterThan(0);
    expect(completed[0].phase).toBe("acceptance-setup");
  });

  test("AC4: completed event has defined passed field when stage skips", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    wireDeps(0);
    await acceptanceSetupStage.execute(makeCtx());

    expect(completed[0]).toBeDefined();
    expect(typeof completed[0].passed).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// AC11: every postrun:phase:completed event carries durationMs measured from
// the matching postrun:phase:started event.
// ---------------------------------------------------------------------------

describe("acceptance-setup events — AC11: durationMs on completed event", () => {
  test("AC11: completed event carries a non-negative durationMs on the RED-gate-fails path", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    wireDeps(1);
    await acceptanceSetupStage.execute(makeCtx());

    expect(typeof completed[0].durationMs).toBe("number");
    expect(completed[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test("AC11 boundary: durationMs is a finite number on the skip path", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    wireDeps(0);
    await acceptanceSetupStage.execute(makeCtx());

    expect(Number.isFinite(completed[0].durationMs)).toBe(true);
    expect(completed[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
