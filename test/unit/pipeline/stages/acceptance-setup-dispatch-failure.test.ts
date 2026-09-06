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
  loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(makeCapturingLogger());
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  loggerSpy?.mockRestore();
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
