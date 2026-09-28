/**
 * US-005: the RED gate repairs a crashing acceptance file.
 *
 * `runAcceptanceRedGate` must tell a genuine RED (a non-zero exit carrying an
 * AC-tagged failure) apart from a test-file load crash, and for a *repairable*
 * crash issue exactly one repair turn followed by a re-run before counting the
 * entry RED. The stage-level tests pin the wiring: `acceptanceSetupStage`
 * passes `_acceptanceSetupDeps`, each group's language and first story id, and
 * the per-package config into the gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, makeDispatchContext, makePRD, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { acceptanceRepairOp } from "@/operations";
import { pipelineEventBus } from "@/pipeline/event-bus";
import {
  type AcceptanceRedGateDeps,
  type AcceptanceRedGateEntry,
  runAcceptanceRedGate,
} from "@/pipeline/stages/acceptance-red-gate";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "@/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "@/pipeline/types";
import { MAX_RAW_TAIL_CHARS } from "@/quality";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOAD_CRASH_WARN = "RED gate: acceptance file crashed on load — issuing one repair turn";
const REPAIR_FAILED_WARN = "RED gate: acceptance repair failed";
const STILL_CRASHES_WARN = "RED gate: acceptance file still crashes after repair";
const EXPECTED_RED_INFO = "RED gate: compile errors are all missing-symbol — expected RED";

/** A TypeScript load crash — no `(fail) AC-` line, so it is a repairable crash. */
const TS_CRASH_OUTPUT = "error: Cannot find module '../src/x'";
/** A Go compile error naming a symbol the feature has not created yet. */
const GO_MISSING_SYMBOL_OUTPUT = "./acceptance_test.go:12:5: undefined: ParseConfig";
/** A Go compile error that is not a missing symbol — a repairable syntax break. */
const GO_SYNTAX_CRASH_OUTPUT = "./acceptance_test.go:20:1: syntax error: unexpected }";
/** A genuine RED: non-zero exit carrying an AC-tagged failure. */
const AC_FAILURE_OUTPUT = "  (fail) AC-1: x\n";

const GROUP_TEST_PATH = "/tmp/nax-red-gate/.nax-acceptance.test.ts";
const GROUP_PACKAGE_DIR = "/tmp/nax-red-gate";
const STAGE_WORKDIR = "/tmp/test-workdir";
const STAGE_FEATURE_DIR = "/tmp/test-workdir/.nax/features/test-feature";
const STAGE_STORY_ID = "US-100";

function makeCtx(): PipelineContext {
  const story = makeStory({ id: STAGE_STORY_ID, acceptanceCriteria: ["AC-1: x"] });
  return {
    config: DEFAULT_CONFIG,
    rootConfig: DEFAULT_CONFIG,
    prd: makePRD({ feature: "test-feature", userStories: [story] }),
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    projectDir: GROUP_PACKAGE_DIR,
    workdir: GROUP_PACKAGE_DIR,
    featureDir: "/tmp/nax-red-gate/.nax/features/test-feature",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
  };
}

function makeEntry(overrides: Partial<AcceptanceRedGateEntry> = {}): AcceptanceRedGateEntry {
  return {
    testPath: GROUP_TEST_PATH,
    packageDir: GROUP_PACKAGE_DIR,
    storyId: STAGE_STORY_ID,
    config: DEFAULT_CONFIG,
    ...overrides,
  };
}

function makeStageCtx(): PipelineContext {
  const story = makeStory({ id: STAGE_STORY_ID, acceptanceCriteria: ["AC-1: x"] });
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement: true,
        redGate: true,
        testPath: "acceptance.test.ts",
      },
    },
    rootConfig: DEFAULT_CONFIG,
    prd: makePRD({ feature: "test-feature", userStories: [story] }),
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    projectDir: STAGE_WORKDIR,
    workdir: STAGE_WORKDIR,
    featureDir: STAGE_FEATURE_DIR,
    hooks: { hooks: {} },
    ...makeDispatchContext(),
  };
}

/** The refine/generate half of the stage's callOp — everything the gate does not own. */
function generateOrRefine(opName: string, input: unknown): unknown {
  if (opName === "acceptance-refine") {
    const { criteria, storyId } = input as { criteria: string[]; storyId: string };
    return criteria.map((c) => ({ original: c, refined: c, testable: true, storyId }));
  }
  if (opName === "acceptance-generate") {
    return { testCode: 'test("AC-1: x", () => { throw new Error("red") })' };
  }
  throw new Error(`unexpected op: ${opName}`);
}

// ---------------------------------------------------------------------------
// Unit-test harness for runAcceptanceRedGate
// ---------------------------------------------------------------------------

interface RepairInput {
  targetTestFilePath?: string;
  outputTail?: string;
}

interface GateHarness {
  deps: AcceptanceRedGateDeps;
  order: string[];
  runTestPaths: string[];
  runTestCmds: string[];
  repairOps: unknown[];
  repairInputs: RepairInput[];
  repairPackageDirs: string[];
  repairStoryIds: Array<string | undefined>;
  writes: Array<{ path: string; content: string }>;
  commits: Array<{ workdir: string; stage: string; role: string }>;
}

function makeHarness(options: {
  outputs: ReadonlyArray<{ exitCode: number; output: string }>;
  repair?: () => Promise<{ testCode: string | null }>;
}): GateHarness {
  const order: string[] = [];
  const runTestPaths: string[] = [];
  const runTestCmds: string[] = [];
  const repairOps: unknown[] = [];
  const repairInputs: RepairInput[] = [];
  const repairPackageDirs: string[] = [];
  const repairStoryIds: Array<string | undefined> = [];
  const writes: Array<{ path: string; content: string }> = [];
  const commits: Array<{ workdir: string; stage: string; role: string }> = [];
  let runIndex = 0;

  const deps: AcceptanceRedGateDeps = {
    runTest: async (testPath, _workdir, cmd) => {
      runIndex += 1;
      order.push(`runTest#${runIndex}`);
      runTestPaths.push(testPath);
      runTestCmds.push(cmd);
      const result = options.outputs[Math.min(runIndex - 1, options.outputs.length - 1)];
      assertDefined(result, "runTest output fixture");
      return result;
    },
    callOp: async (_ctx, packageDir, op, input, storyId) => {
      order.push(`callOp:${op.name}`);
      if (op.name !== acceptanceRepairOp.name) throw new Error(`unexpected op: ${op.name}`);
      repairOps.push(op);
      repairInputs.push(input);
      repairPackageDirs.push(packageDir);
      repairStoryIds.push(storyId);
      return options.repair ? options.repair() : { testCode: null };
    },
    writeFile: async (filePath, content) => {
      order.push("writeFile");
      writes.push({ path: filePath, content });
    },
    autoCommitIfDirty: async (workdir, stage, role) => {
      order.push("autoCommit");
      commits.push({ workdir, stage, role });
    },
  };

  return {
    deps,
    order,
    runTestPaths,
    runTestCmds,
    repairOps,
    repairInputs,
    repairPackageDirs,
    repairStoryIds,
    writes,
    commits,
  };
}

// ---------------------------------------------------------------------------
// Stage-level wiring
// ---------------------------------------------------------------------------

interface StageRunTestCall {
  testPath: string;
  packageDir: string;
}

interface StageHarness {
  runTestCalls: StageRunTestCall[];
}

function wireStageDeps(options: {
  runTest: (testPath: string, packageDir: string) => Promise<{ exitCode: number; output: string }>;
  callOp: typeof _acceptanceSetupDeps.callOp;
}): StageHarness {
  const runTestCalls: StageRunTestCall[] = [];
  _acceptanceSetupDeps.fileExists = async () => false;
  _acceptanceSetupDeps.readMeta = async () => null;
  _acceptanceSetupDeps.copyFile = async () => {};
  _acceptanceSetupDeps.deleteFile = async () => {};
  _acceptanceSetupDeps.writeFile = async () => {};
  _acceptanceSetupDeps.writeMeta = async () => {};
  _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
  _acceptanceSetupDeps.loadGroupConfig = async () => DEFAULT_CONFIG;
  _acceptanceSetupDeps.callOp = options.callOp;
  _acceptanceSetupDeps.runTest = async (testPath, packageDir) => {
    runTestCalls.push({ testPath, packageDir });
    return options.runTest(testPath, packageDir);
  };
  return { runTestCalls };
}

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------

let captured: LogEntry[];
let unsubscribe: (() => void) | null = null;
let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
  captured = [];
  resetLogger();
  initLogger({ level: "debug", suppressConsole: true });
  unsubscribe = addSink((entry) => {
    captured.push(entry);
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  resetLogger();
  Object.assign(_acceptanceSetupDeps, savedDeps);
});

function entriesWithMessage(message: string): LogEntry[] {
  return captured.filter((entry) => entry.message === message);
}

// ---------------------------------------------------------------------------
// AC1–AC5, AC12: a repairable TypeScript load crash
// ---------------------------------------------------------------------------

describe("US-005 runAcceptanceRedGate: repairable crash", () => {
  test("AC1: asks acceptanceRepairOp once with the group testPath and the output tail", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 1, output: TS_CRASH_OUTPUT }] });

    const redCount = await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(redCount).toBe(1);
    expect(harness.repairOps).toHaveLength(1);
    expect(harness.repairOps[0]).toBe(acceptanceRepairOp);
    expect(harness.repairInputs[0]?.targetTestFilePath).toBe(GROUP_TEST_PATH);
    expect(harness.repairInputs[0]?.outputTail).toBe(TS_CRASH_OUTPUT);
    expect(harness.repairPackageDirs[0]).toBe(GROUP_PACKAGE_DIR);
    expect(harness.repairStoryIds[0]).toBe(STAGE_STORY_ID);
  });

  test("AC1 boundary: outputTail is capped to the last MAX_RAW_TAIL_CHARS characters", async () => {
    const longOutput = `${"x".repeat(MAX_RAW_TAIL_CHARS + 500)}${TS_CRASH_OUTPUT}`;
    const harness = makeHarness({ outputs: [{ exitCode: 1, output: longOutput }] });

    await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(harness.repairInputs[0]?.outputTail).toBe(longOutput.slice(-MAX_RAW_TAIL_CHARS));
    expect(harness.repairInputs[0]?.outputTail?.length).toBe(MAX_RAW_TAIL_CHARS);
    expect(harness.repairInputs[0]?.outputTail).not.toBe(longOutput);
  });

  test("AC2: re-runs the same testPath a second time after the repair", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 1, output: TS_CRASH_OUTPUT }] });

    const redCount = await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(harness.runTestPaths).toEqual([GROUP_TEST_PATH, GROUP_TEST_PATH]);
    expect(redCount).toBe(1);
  });

  test("AC3: writes the repaired testCode to the group testPath before the second run", async () => {
    const harness = makeHarness({
      outputs: [{ exitCode: 1, output: TS_CRASH_OUTPUT }],
      repair: async () => ({ testCode: "REPAIRED TEST CODE" }),
    });

    await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(harness.writes).toContainEqual({ path: GROUP_TEST_PATH, content: "REPAIRED TEST CODE" });
    expect(harness.order.indexOf("writeFile")).toBeLessThan(harness.order.indexOf("runTest#2"));
  });

  test("AC4: auto-commits after the repair and before the second run", async () => {
    const harness = makeHarness({
      outputs: [{ exitCode: 1, output: TS_CRASH_OUTPUT }],
      repair: async () => ({ testCode: "REPAIRED TEST CODE" }),
    });

    await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    const commitIndex = harness.order.indexOf("autoCommit");
    expect(commitIndex).toBeGreaterThan(harness.order.indexOf(`callOp:${acceptanceRepairOp.name}`));
    expect(commitIndex).toBeLessThan(harness.order.indexOf("runTest#2"));
    expect(harness.commits).toHaveLength(1);
  });

  test("AC5: a second crash stops at two runs, one repair, and a warn naming the testPath", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 1, output: TS_CRASH_OUTPUT }] });

    const redCount = await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(harness.runTestPaths).toHaveLength(2);
    expect(harness.repairOps).toHaveLength(1);
    expect(redCount).toBe(1);

    const warns = entriesWithMessage(STILL_CRASHES_WARN);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data?.testPath).toBe(GROUP_TEST_PATH);
    expect(warns[0]?.data?.storyId).toBe(STAGE_STORY_ID);
  });

  test("AC5 boundary: the load crash itself is announced with a warn naming the testPath", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 1, output: TS_CRASH_OUTPUT }] });

    await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    const warns = entriesWithMessage(LOAD_CRASH_WARN);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data?.testPath).toBe(GROUP_TEST_PATH);
  });

  test("AC12: a null testCode leaves the file untouched but still re-runs it", async () => {
    const harness = makeHarness({
      outputs: [{ exitCode: 1, output: TS_CRASH_OUTPUT }],
      repair: async () => ({ testCode: null }),
    });

    await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(harness.writes.filter((write) => write.path === GROUP_TEST_PATH)).toHaveLength(0);
    expect(harness.runTestPaths).toHaveLength(2);
  });

  test("US-005: a second-run executor throw propagates and is not reported as a repair failure", async () => {
    let runs = 0;
    const deps: AcceptanceRedGateDeps = {
      runTest: async () => {
        runs += 1;
        if (runs === 2) throw new Error("second run exploded");
        return { exitCode: 1, output: TS_CRASH_OUTPUT };
      },
      callOp: async () => ({ testCode: null }),
      writeFile: async () => {},
      autoCommitIfDirty: async () => {},
    };

    await expect(runAcceptanceRedGate(makeCtx(), [makeEntry()], deps)).rejects.toThrow("second run exploded");
    expect(entriesWithMessage(REPAIR_FAILED_WARN)).toHaveLength(0);
  });

  test("US-005: a writeFile rejection surfaces rather than being logged as a repair failure", async () => {
    const deps: AcceptanceRedGateDeps = {
      runTest: async () => ({ exitCode: 1, output: TS_CRASH_OUTPUT }),
      callOp: async () => ({ testCode: "REPAIRED TEST CODE" }),
      writeFile: async () => {
        throw new Error("disk full");
      },
      autoCommitIfDirty: async () => {},
    };

    await expect(runAcceptanceRedGate(makeCtx(), [makeEntry()], deps)).rejects.toThrow("disk full");
    expect(entriesWithMessage(REPAIR_FAILED_WARN)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC6–AC7: language-specific crash classification
// ---------------------------------------------------------------------------

describe("US-005 runAcceptanceRedGate: crash classification", () => {
  test("AC6: an all-missing-symbol Go crash is expected RED — no repair call", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 1, output: GO_MISSING_SYMBOL_OUTPUT }] });

    const redCount = await runAcceptanceRedGate(
      makeCtx(),
      [makeEntry({ language: "go", testPath: "/tmp/pkg/.nax-acceptance_test.go" })],
      harness.deps,
    );

    expect(redCount).toBe(1);
    expect(harness.repairOps).toHaveLength(0);
    expect(harness.runTestPaths).toHaveLength(1);

    const infos = entriesWithMessage(EXPECTED_RED_INFO);
    expect(infos).toHaveLength(1);
    expect(infos[0]?.data?.testPath).toBe("/tmp/pkg/.nax-acceptance_test.go");
    expect(infos[0]?.data?.language).toBe("go");
  });

  test("AC7: a Go syntax error is repairable — one repair call", async () => {
    const harness = makeHarness({
      outputs: [{ exitCode: 1, output: GO_SYNTAX_CRASH_OUTPUT }],
      repair: async () => ({ testCode: null }),
    });

    const redCount = await runAcceptanceRedGate(
      makeCtx(),
      [makeEntry({ language: "go", testPath: "/tmp/pkg/.nax-acceptance_test.go" })],
      harness.deps,
    );

    expect(harness.repairOps).toHaveLength(1);
    expect(redCount).toBe(1);
    expect(entriesWithMessage(EXPECTED_RED_INFO)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC8–AC9: genuine RED and green runs are never repaired
// ---------------------------------------------------------------------------

describe("US-005 runAcceptanceRedGate: no repair when the outcome is unambiguous", () => {
  test("AC8: a non-zero exit carrying an AC-tagged failure is RED with no repair", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 1, output: AC_FAILURE_OUTPUT }] });

    const redCount = await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(redCount).toBe(1);
    expect(harness.runTestPaths).toHaveLength(1);
    expect(harness.repairOps).toHaveLength(0);
  });

  test("AC9: a zero exit is not RED and is never repaired", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 0, output: "3 pass" }] });

    const redCount = await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(redCount).toBe(0);
    expect(harness.runTestPaths).toHaveLength(1);
    expect(harness.repairOps).toHaveLength(0);
  });

  test("AC9 boundary: a clean group among crashing ones still contributes zero", async () => {
    const harness = makeHarness({
      outputs: [
        { exitCode: 0, output: "3 pass" },
        { exitCode: 1, output: AC_FAILURE_OUTPUT },
      ],
    });

    const redCount = await runAcceptanceRedGate(
      makeCtx(),
      [makeEntry(), makeEntry({ testPath: "/tmp/nax-red-gate/second.test.ts" })],
      harness.deps,
    );

    expect(redCount).toBe(1);
    expect(harness.repairOps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC1, AC10, AC11: stage-level wiring
// ---------------------------------------------------------------------------

describe("US-005 acceptanceSetupStage: RED gate repair wiring", () => {
  test("AC1: the stage's first RED run that crashes asks _acceptanceSetupDeps.callOp for acceptanceRepairOp", async () => {
    const repairInputs: RepairInput[] = [];
    const repairOps: unknown[] = [];
    wireStageDeps({
      runTest: async () => ({ exitCode: 1, output: TS_CRASH_OUTPUT }),
      callOp: async (_ctx, _packageDir, op, input) => {
        if (op.name === acceptanceRepairOp.name) {
          repairOps.push(op);
          repairInputs.push(input);
          return { testCode: null };
        }
        return generateOrRefine(op.name, input);
      },
    });

    const ctx = makeStageCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(repairOps).toHaveLength(1);
    expect(repairOps[0]).toBe(acceptanceRepairOp);
    const groupTestPath = ctx.acceptanceTestPaths?.[0]?.testPath;
    expect(groupTestPath).toContain(".nax/features/test-feature");
    expect(repairInputs[0]?.targetTestFilePath).toBe(groupTestPath);
    expect(repairInputs[0]?.outputTail).toBe(TS_CRASH_OUTPUT);
  });

  test("AC10: a rejected repair warns, skips the re-run, and the stage still continues", async () => {
    const harness = wireStageDeps({
      runTest: async () => ({ exitCode: 1, output: TS_CRASH_OUTPUT }),
      callOp: async (_ctx, _packageDir, op, input) => {
        if (op.name === acceptanceRepairOp.name) throw new Error("repair dispatch failed");
        return generateOrRefine(op.name, input);
      },
    });

    const ctx = makeStageCtx();
    const result = await acceptanceSetupStage.execute(ctx);

    const warns = entriesWithMessage(REPAIR_FAILED_WARN);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data?.testPath).toBe(ctx.acceptanceTestPaths?.[0]?.testPath);
    expect(warns[0]?.data?.storyId).toBe(STAGE_STORY_ID);

    expect(harness.runTestCalls).toHaveLength(1);
    expect(result.action).toBe("continue");
  });

  test("AC11: a group that crashes on both runs contributes exactly 1 to redFailCount", async () => {
    const harness = wireStageDeps({
      runTest: async () => ({ exitCode: 1, output: TS_CRASH_OUTPUT }),
      callOp: async (_ctx, _packageDir, op, input) => {
        if (op.name === acceptanceRepairOp.name) return { testCode: null };
        return generateOrRefine(op.name, input);
      },
    });

    const redFailCounts: number[] = [];
    const off = pipelineEventBus.on("postrun:phase:completed", (event) => {
      if (event.phase !== "acceptance-setup") return;
      const details = event.details;
      if (details && "redFailCount" in details) redFailCounts.push(details.redFailCount);
    });

    try {
      const ctx = makeStageCtx();
      await acceptanceSetupStage.execute(ctx);

      // The crash was repaired and re-run — but it counts RED exactly once.
      expect(harness.runTestCalls).toHaveLength(2);
      expect(redFailCounts).toEqual([1]);
      expect(ctx.acceptanceSetup?.redFailCount).toBe(1);
    } finally {
      off();
    }
  });
});

// ---------------------------------------------------------------------------
// US-001: the gate hands the runner ONE shell command string
// ---------------------------------------------------------------------------

interface RunTestCall {
  testPath: string;
  workdir: string;
  cmd: string;
  timeoutMs: number | undefined;
}

/** A gate deps set whose `runTest` records every argument it is handed. */
function makeRecordingDeps(outputs: ReadonlyArray<{ exitCode: number; output: string }>): {
  deps: AcceptanceRedGateDeps;
  calls: RunTestCall[];
} {
  const calls: RunTestCall[] = [];
  let runIndex = 0;
  const deps: AcceptanceRedGateDeps = {
    runTest: async (testPath, workdir, cmd, timeoutMs) => {
      calls.push({ testPath, workdir, cmd, timeoutMs });
      const result = outputs[Math.min(runIndex, outputs.length - 1)];
      runIndex += 1;
      assertDefined(result, "runTest output fixture");
      return result;
    },
    callOp: async () => ({ testCode: null }),
    writeFile: async () => {},
    autoCommitIfDirty: async () => {},
  };
  return { deps, calls };
}

describe("US-001 runAcceptanceRedGate: command string, not argv", () => {
  test("AC11: passes the built command string to runTest for an override with an env assignment", async () => {
    const { deps, calls } = makeRecordingDeps([{ exitCode: 0, output: "1 pass" }]);

    const redCount = await runAcceptanceRedGate(
      makeCtx(),
      [makeEntry({ testPath: "/repo/.nax-acceptance.test.ts", commandOverride: "FOO=1 bun test {{FILE}}" })],
      deps,
    );

    expect(redCount).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.testPath).toBe("/repo/.nax-acceptance.test.ts");
    expect(calls[0]?.workdir).toBe(GROUP_PACKAGE_DIR);
    expect(calls[0]?.cmd).toBe("FOO=1 bun test '/repo/.nax-acceptance.test.ts'");
  });

  test("AC11 boundary: an entry without an override runs the quote-joined framework default", async () => {
    const { deps, calls } = makeRecordingDeps([{ exitCode: 0, output: "1 pass" }]);

    await runAcceptanceRedGate(makeCtx(), [makeEntry({ testFramework: "jest" })], deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe(`'npx' 'jest' '${GROUP_TEST_PATH}'`);
  });

  test("AC11 boundary: the logged command is the same shell string the runner receives", async () => {
    const { deps } = makeRecordingDeps([{ exitCode: 0, output: "1 pass" }]);

    await runAcceptanceRedGate(
      makeCtx(),
      [makeEntry({ testPath: "/repo/.nax-acceptance.test.ts", commandOverride: "FOO=1 bun test {{FILE}}" })],
      deps,
    );

    const logged = entriesWithMessage("Running acceptance RED gate command");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.data?.cmd).toBe("FOO=1 bun test '/repo/.nax-acceptance.test.ts'");
  });
});

// ---------------------------------------------------------------------------
// US-002: command not runnable (exit 126 / 127) — named, not repaired
// ---------------------------------------------------------------------------

const COMMAND_NOT_RUNNABLE_RED_MSG = "RED gate: acceptance command could not run — check acceptance.command";
const TS_EXIT_1_OUTPUT = "SyntaxError: Unexpected token";

describe("US-002 runAcceptanceRedGate: command not runnable (exit 126/127)", () => {
  test("AC5: exit 127 never dispatches acceptanceRepairOp — deps.callOp is never called", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 127, output: "/bin/sh: FOO: command not found" }] });

    const redCount = await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(harness.repairOps).toHaveLength(0);
    expect(harness.order.filter((entry) => entry.startsWith("callOp:"))).toHaveLength(0);
    expect(redCount).toBe(1);
  });

  test("AC6: exit 127 calls runTest exactly once and never calls writeFile or autoCommitIfDirty", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 127, output: "/bin/sh: FOO: command not found" }] });

    await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(harness.runTestPaths).toHaveLength(1);
    expect(harness.writes).toHaveLength(0);
    expect(harness.commits).toHaveLength(0);
  });

  test("AC7: exit 127 logs one error from stage 'acceptance-setup' with storyId first, cmd, and exitCode", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 127, output: "/bin/sh: FOO: command not found" }] });

    await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    const errors = captured.filter(
      (entry) =>
        entry.level === "error" && entry.stage === "acceptance-setup" && entry.message === COMMAND_NOT_RUNNABLE_RED_MSG,
    );
    expect(errors).toHaveLength(1);
    const data = errors[0]?.data ?? {};
    expect(Object.keys(data)[0]).toBe("storyId");
    expect(data.storyId).toBe(STAGE_STORY_ID);
    // cmd must equal the command the gate handed to deps.runTest (AC7 explicitly
    // requires it — a bare "non-empty string" would also pass if the gate logged
    // a different shell string than the one it actually ran).
    expect(harness.runTestCmds).toHaveLength(1);
    expect(data.cmd).toBe(harness.runTestCmds[0]);
    expect(data.exitCode).toBe(127);
  });

  test("AC8: exit 127 returns 1 from runAcceptanceRedGate, so the entry still counts RED", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 127, output: "/bin/sh: FOO: command not found" }] });

    const redCount = await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(redCount).toBe(1);
  });

  test("AC9 boundary: exit 126 also skips repair and logs the not-runnable error", async () => {
    const harness = makeHarness({ outputs: [{ exitCode: 126, output: "sh: FOO: Permission denied" }] });

    await runAcceptanceRedGate(makeCtx(), [makeEntry()], harness.deps);

    expect(harness.repairOps).toHaveLength(0);
    expect(harness.writes).toHaveLength(0);
    expect(harness.commits).toHaveLength(0);

    const errors = captured.filter(
      (entry) =>
        entry.level === "error" && entry.stage === "acceptance-setup" && entry.message === COMMAND_NOT_RUNNABLE_RED_MSG,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data?.exitCode).toBe(126);
  });

  test("AC10: a TypeScript exit 1 still goes through the existing repair path", async () => {
    const harness = makeHarness({
      outputs: [{ exitCode: 1, output: TS_EXIT_1_OUTPUT }],
      repair: async () => ({ testCode: null }),
    });

    const redCount = await runAcceptanceRedGate(makeCtx(), [makeEntry({ language: "typescript" })], harness.deps);

    expect(harness.repairOps).toHaveLength(1);
    expect(harness.repairOps[0]).toBe(acceptanceRepairOp);
    expect(redCount).toBe(1);
    // The not-runnable error is not emitted for an exit 1 with no AC failures.
    const notRunnable = captured.filter(
      (entry) => entry.level === "error" && entry.message === COMMAND_NOT_RUNNABLE_RED_MSG,
    );
    expect(notRunnable).toHaveLength(0);
  });
});
