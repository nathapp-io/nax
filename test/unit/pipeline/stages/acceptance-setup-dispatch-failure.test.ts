/**
 * US-002: acceptance-setup — do not fabricate skeletons for dispatch failures.
 *
 * The generation branch is three-way:
 *   1. truthy `testCode` → written unchanged (AC4).
 *   2. falsy `testCode` + no `adapterFailure` → skeleton path (AC3).
 *   3. falsy `testCode` + `adapterFailure` → write nothing, warn distinct from skeleton (AC1, AC2, AC5).
 *
 * The third branch leaves the package in `ctx.acceptanceTestPaths` with the
 * missing file — `acceptanceStage` then routes the package into its existing
 * missing-target path (AC6 / US-003).
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, spyOn, test } from "bun:test";
import { makeDispatchContext, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import * as loggerModule from "@/logger";
import { type PostRunPhaseCompletedEvent, type PostRunPhaseStartedEvent, pipelineEventBus } from "@/pipeline";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "@/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [
    makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: first criterion", "AC-2: second criterion"] }),
    makeStory({ id: "US-002", acceptanceCriteria: ["AC-3: third criterion"] }),
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
    },
    prd: makePrd(stories),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-workdir",
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
    ...overrides,
  };
}

const FAILED_DISPATCH: AdapterFailure = {
  category: "availability",
  outcome: "fail-service-down",
  message: "Upstream idle timeout exceeded",
  retriable: true,
};

// ---------------------------------------------------------------------------
// Save/restore deps + spy on getSafeLogger so we can capture warn calls
// ---------------------------------------------------------------------------

let savedDeps: typeof _acceptanceSetupDeps;
let loggerSpy: Mock<typeof loggerModule.getSafeLogger> | undefined;
let logWarnCalls: Array<[string, string, unknown]>;

function makeCapturingLogger() {
  return Object.assign(new loggerModule.Logger({ level: "silent", suppressConsole: true }), {
    warn: mock((...args: [string, string, unknown]) => {
      logWarnCalls.push(args);
    }),
    error: mock(() => {}),
    debug: mock(() => {}),
  });
}

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
  logWarnCalls = [];
  pipelineEventBus.clear();
  loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(makeCapturingLogger());
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  loggerSpy?.mockRestore();
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC1 + AC2 + AC5: failed dispatch → no write, distinct warn, file untouched
// ---------------------------------------------------------------------------

describe("US-002: failed dispatch — falsy testCode with adapterFailure", () => {
  function wireFailedDispatchDeps() {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: null, adapterFailure: FAILED_DISPATCH };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = mock(async () => {});
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
  }

  test("AC1: makes no writeFile call whose path is the group's acceptance test path", async () => {
    wireFailedDispatchDeps();

    await acceptanceSetupStage.execute(makeCtx());

    const writeFileMock = _acceptanceSetupDeps.writeFile as ReturnType<typeof mock>;
    const writeCalls = writeFileMock.mock.calls as Array<[string, string]>;
    const targetPaths = writeCalls.map(([path]) => path);
    const testTargetMatches = targetPaths.filter((p) => p.includes(".nax-acceptance.test.ts"));
    expect(testTargetMatches).toEqual([]);
  });

  test("AC2: emits a warning on the 'acceptance-setup' channel whose message differs from the skeleton one", async () => {
    wireFailedDispatchDeps();

    await acceptanceSetupStage.execute(makeCtx());

    const skeletonMessage = "agent did not produce test content; using skeleton";
    const warnsOnAcceptanceSetup = logWarnCalls.filter(([stage]) => stage === "acceptance-setup");
    expect(warnsOnAcceptanceSetup.length).toBeGreaterThan(0);
    for (const [, message] of warnsOnAcceptanceSetup) {
      expect(message).not.toBe(skeletonMessage);
    }
  });

  test("AC2: warning metadata carries outcome and message from adapterFailure", async () => {
    wireFailedDispatchDeps();

    await acceptanceSetupStage.execute(makeCtx());

    const warnsOnAcceptanceSetup = logWarnCalls.filter(([stage]) => stage === "acceptance-setup");
    expect(warnsOnAcceptanceSetup.length).toBeGreaterThan(0);
    const dataForWarn = warnsOnAcceptanceSetup[0]?.[2] as Record<string, unknown> | undefined;
    expect(dataForWarn).toBeDefined();
    expect(dataForWarn?.outcome).toBe("fail-service-down");
    expect(dataForWarn?.message).toBe("Upstream idle timeout exceeded");
  });

  test("AC5: a file already at the target path is left unchanged when dispatch fails", async () => {
    wireFailedDispatchDeps();
    const targetPath = "/tmp/test-workdir/.nax/features/test-feature/.nax-acceptance.test.ts";
    const priorContent = "// prior content from earlier generation\ntest('AC-1', () => {})\n";

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.readFile = async (p: string) => (p === targetPath ? priorContent : "");

    await acceptanceSetupStage.execute(makeCtx());

    const writeFileMock = _acceptanceSetupDeps.writeFile as ReturnType<typeof mock>;
    const writeCalls = writeFileMock.mock.calls as Array<[string, string]>;
    const targetWrites = writeCalls.filter(([path]) => path === targetPath);
    expect(targetWrites.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC3: falsy testCode + no adapterFailure → skeleton path (unchanged)
// ---------------------------------------------------------------------------

describe("US-002: model-quality empty — falsy testCode without adapterFailure", () => {
  function wireEmptyNoFailureDeps() {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: null };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = mock(async () => {});
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
  }

  test("AC3: writes skeleton content to the group's acceptance test path", async () => {
    wireEmptyNoFailureDeps();

    await acceptanceSetupStage.execute(makeCtx());

    const writeFileMock = _acceptanceSetupDeps.writeFile as ReturnType<typeof mock>;
    const writeCalls = writeFileMock.mock.calls as Array<[string, string]>;
    const targetPath = "/tmp/test-workdir/.nax/features/test-feature/.nax-acceptance.test.ts";
    const targetWrites = writeCalls.filter(([path]) => path === targetPath);
    expect(targetWrites.length).toBe(1);
    expect(targetWrites[0]?.[1]?.length ?? 0).toBeGreaterThan(0);
  });

  test("AC3: emits the skeleton warning verbatim", async () => {
    wireEmptyNoFailureDeps();

    await acceptanceSetupStage.execute(makeCtx());

    const skeletonMessage = "agent did not produce test content; using skeleton";
    const warnsOnAcceptanceSetup = logWarnCalls.filter(
      ([stage, message]) => stage === "acceptance-setup" && message === skeletonMessage,
    );
    expect(warnsOnAcceptanceSetup.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC4: truthy testCode + adapterFailure → write the testCode
// ---------------------------------------------------------------------------

describe("US-002: truthy testCode with adapterFailure — write the testCode", () => {
  test("AC4: writes the supplied testCode to the group's acceptance test path even when adapterFailure is present", async () => {
    const realTestCode = 'test("AC-1", () => { throw new Error("red") })';

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        // Mirror callOp attachOutcomeAdapterFailure behaviour — a producer's
        // own adapterFailure wins over the dispatch outcome's.
        return { testCode: realTestCode, adapterFailure: FAILED_DISPATCH };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = mock(async () => {});
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    const writeFileMock = _acceptanceSetupDeps.writeFile as ReturnType<typeof mock>;
    const writeCalls = writeFileMock.mock.calls as Array<[string, string]>;
    const targetPath = "/tmp/test-workdir/.nax/features/test-feature/.nax-acceptance.test.ts";
    const targetWrites = writeCalls.filter(([path]) => path === targetPath);
    expect(targetWrites.length).toBe(1);
    expect(targetWrites[0]?.[1]).toBe(realTestCode);
  });
});

// ---------------------------------------------------------------------------
// #1896: a dispatch failure must not stamp acceptance-meta.json
//
// writeMeta sits outside the per-group loop and ran unconditionally, so the
// AC fingerprint was recorded for a suite that was never written. On the next
// run the gate matches and takes the reuse branch, which explicitly blesses a
// missing file — and the stub guard cannot recover it, because that guard
// keys on file CONTENT and findExistingAcceptanceTestPath returns undefined
// when nothing is on disk. The empty suite then survives every later run.
// ---------------------------------------------------------------------------

describe("#1896: acceptance-meta is not stamped for a suite that was never written", () => {
  function wireDeps(generateResult: () => { testCode: string | null; adapterFailure?: AdapterFailure }) {
    // The mock is held locally and returned rather than read back off
    // _acceptanceSetupDeps, so the assertion needs no cast to see mock.calls.
    const writeMetaMock = mock(async () => {});
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        return generateResult();
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = writeMetaMock;
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
    return writeMetaMock;
  }

  test("makes no writeMeta call when the generation dispatch failed", async () => {
    const writeMetaMock = wireDeps(() => ({ testCode: null, adapterFailure: FAILED_DISPATCH }));

    await acceptanceSetupStage.execute(makeCtx());

    expect(writeMetaMock.mock.calls.length).toBe(0);
  });

  test("still stamps meta when generation succeeded", async () => {
    const writeMetaMock = wireDeps(() => ({
      testCode: "test('AC-1', () => { expect(sweep()).toBe(2) })",
    }));

    await acceptanceSetupStage.execute(makeCtx());

    expect(writeMetaMock.mock.calls.length).toBe(1);
  });

  test("still stamps meta when generation fell back to a skeleton", async () => {
    const writeMetaMock = wireDeps(() => ({ testCode: null }));

    await acceptanceSetupStage.execute(makeCtx());

    expect(writeMetaMock.mock.calls.length).toBe(1);
  });

  test("warns on the acceptance-setup channel, naming the story, when the stamp is skipped", async () => {
    wireDeps(() => ({ testCode: null, adapterFailure: FAILED_DISPATCH }));

    await acceptanceSetupStage.execute(makeCtx());

    const metaWarns = logWarnCalls.filter(
      ([stage, message]) => stage === "acceptance-setup" && message.includes("not recording acceptance meta"),
    );
    expect(metaWarns.length).toBe(1);
    expect(metaWarns[0]?.[2]).toMatchObject({ storyId: "US-001" });
  });

  test("skips the stamp when only one of two package groups failed to generate", async () => {
    // The single-group default would pass even if the flag were scoped to the
    // last group, so the cross-group semantic needs two real groups. Group A
    // succeeds and group B's dispatch fails: meta must still not be stamped,
    // or B's missing suite becomes permanent via the reuse branch.
    const stories = [
      makeStory({ id: "US-001", workdir: "packages/a", acceptanceCriteria: ["AC-1: first criterion"] }),
      makeStory({ id: "US-002", workdir: "packages/b", acceptanceCriteria: ["AC-2: second criterion"] }),
    ];
    let generateCalls = 0;
    const writeMetaMock = mock(async () => {});
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        generateCalls++;
        return generateCalls === 1
          ? { testCode: "test('AC-1', () => { expect(sweep()).toBe(2) })" }
          : { testCode: null, adapterFailure: FAILED_DISPATCH };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = writeMetaMock;
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx({ prd: makePrd(stories), story: stories[0], stories }));

    expect(generateCalls).toBe(2);
    expect(writeMetaMock.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Absorbed: acceptance-setup-events.test.ts
// ---------------------------------------------------------------------------

function eventsTestStory(id: string, criteria: string[]) {
  return makeStory({ id, title: `Story ${id}`, description: "desc", acceptanceCriteria: criteria });
}

function eventsMakePrd(stories: ReturnType<typeof eventsTestStory>[]) {
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
function eventsMakeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [
    eventsTestStory("US-001", ["AC-1: first criterion", "AC-2: second criterion"]),
    eventsTestStory("US-002", ["AC-1: third criterion"]),
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
    prd: eventsMakePrd(stories),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-acceptance-events",
    projectDir: "/tmp/test-acceptance-events",
    featureDir: "/tmp/test-acceptance-events/.nax/features/test-feature",
    hooks: {} as PipelineContext["hooks"],
    ...makeDispatchContext(),
    ...overrides,
  };
}

/** Wire all injectable deps so execute() can reach the bus-emit point. */
function eventsWireDeps(runTestExitCode: number) {
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

describe("acceptance-setup events — AC1: postrun:phase:started before generation", () => {
  test("AC1: emits postrun:phase:started with phase 'acceptance-setup'", async () => {
    const started: PostRunPhaseStartedEvent[] = [];
    pipelineEventBus.on("postrun:phase:started", (e) => {
      started.push(e);
    });

    eventsWireDeps(1);
    await acceptanceSetupStage.execute(eventsMakeCtx());

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

    await acceptanceSetupStage.execute(eventsMakeCtx());

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

    await acceptanceSetupStage.execute(eventsMakeCtx({ featureDir: undefined }));

    expect(started.length).toBe(0);
  });
});

describe("acceptance-setup events — AC2: completed passed:true on RED-gate failure", () => {
  test("AC2: emits postrun:phase:completed with passed:true when exit code != 0", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    eventsWireDeps(1); // exit 1 = RED gate fails (valid RED, stage continues)
    await acceptanceSetupStage.execute(eventsMakeCtx());

    expect(completed.length).toBeGreaterThan(0);
    expect(completed[0].passed).toBe(true);
  });

  test("AC2: completed event is emitted exactly once per execute call", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    eventsWireDeps(1);
    await acceptanceSetupStage.execute(eventsMakeCtx());

    expect(completed.length).toBe(1);
  });
});

describe("acceptance-setup events — AC3: details match recorded stage values", () => {
  test("AC3: details.totalCriteria equals sum of ACs across all non-fix stories", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    eventsWireDeps(1);
    await acceptanceSetupStage.execute(eventsMakeCtx()); // 3 total criteria

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

    const ctx = eventsMakeCtx({
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

    eventsWireDeps(1); // one package, exit code 1 → redFailCount = 1
    await acceptanceSetupStage.execute(eventsMakeCtx());

    const details = completed[0]?.details as Record<string, unknown> | undefined;
    expect(details?.redFailCount).toBe(1);
  });

  test("AC3: details.regenerated is true when test file was generated this run", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    eventsWireDeps(1); // readMeta returns null → shouldGenerate = true → regenerated
    await acceptanceSetupStage.execute(eventsMakeCtx());

    const details = completed[0]?.details as Record<string, unknown> | undefined;
    expect(details?.regenerated).toBe(true);
  });
});

describe("acceptance-setup events — AC4: completed emitted when stage skips", () => {
  test("AC4: emits postrun:phase:completed when all acceptance tests already pass", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    eventsWireDeps(0); // exit 0 = tests already pass → stage returns skip
    const result = await acceptanceSetupStage.execute(eventsMakeCtx());

    expect(result.action).toBe("skip");
    expect(completed.length).toBeGreaterThan(0);
    expect(completed[0].phase).toBe("acceptance-setup");
  });

  test("AC4: completed event has defined passed field when stage skips", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    eventsWireDeps(0);
    await acceptanceSetupStage.execute(eventsMakeCtx());

    expect(completed[0]).toBeDefined();
    expect(typeof completed[0].passed).toBe("boolean");
  });
});

describe("acceptance-setup events — AC11: durationMs on completed event", () => {
  test("AC11: completed event carries a non-negative durationMs on the RED-gate-fails path", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    eventsWireDeps(1);
    await acceptanceSetupStage.execute(eventsMakeCtx());

    expect(typeof completed[0].durationMs).toBe("number");
    expect(completed[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test("AC11 boundary: durationMs is a finite number on the skip path", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    eventsWireDeps(0);
    await acceptanceSetupStage.execute(eventsMakeCtx());

    expect(Number.isFinite(completed[0].durationMs)).toBe(true);
    expect(completed[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("acceptance-setup events — exception safety", () => {
  test("a thrown error mid-setup still emits postrun:phase:completed with passed:false, then rethrows", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      if (e.phase === "acceptance-setup") completed.push(e);
    });

    eventsWireDeps(1);
    _acceptanceSetupDeps.writeMeta = async () => {
      throw new Error("disk full");
    };

    await expect(acceptanceSetupStage.execute(eventsMakeCtx())).rejects.toThrow("disk full");
    expect(completed).toHaveLength(1);
    expect(completed[0].passed).toBe(false);
  });
});
