/**
 * Tests for the run-start baseline capture call site of `runExecutionPhase`.
 *
 * AC11 of US-002: the capture runs exactly once, before the first story
 * pipeline dispatch, with the run config and workdir.
 *
 * US-001 of run-start-baseline-fixes: the capture is skipped entirely when no
 * story is pending, so a `--publish-only` (or re-run of a finished feature)
 * leaves an existing `test-baseline.json` byte-identical.
 *
 * The capture function itself is exercised elsewhere
 * (`test/unit/execution/lifecycle/test-baseline-capture*.test.ts`); these tests
 * observe the call site through `_captureDeps`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { featureDir } from "@/config";
import { _captureDeps } from "@/execution/lifecycle/test-baseline-capture";
import type { RunnerExecutionOptions } from "@/execution/runner-execution";
import { runExecutionPhase } from "@/execution/runner-execution";
import { _unifiedExecutorDeps } from "@/execution/unified-executor";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { PRD } from "@/prd";

const originalDeps = { ..._captureDeps };
const origRunIteration = _unifiedExecutorDeps.runIteration;
const origRunWorkflowPreflight = _unifiedExecutorDeps.runWorkflowPreflight;

const tempDirs: string[] = [];
let logEntries: LogEntry[] = [];

beforeEach(() => {
  Object.assign(_captureDeps, originalDeps);
  // No resolvable test command, so no capture can spawn a real test suite — a
  // regression in the skip guard then shows up as an extra write, not as a
  // minutes-long run. `writeNoBaseline` still goes through `writeRunBaseline`.
  _captureDeps.resolveTestCommands = async () => undefined;
  // A pending story makes `executeUnified` run the workflow pre-flight, which would
  // reach a real advisor. It is not this file's subject.
  _unifiedExecutorDeps.runWorkflowPreflight = async () => {};
  resetLogger();
  logEntries = [];
  initLogger({ level: "debug" });
  addSink((entry) => logEntries.push(entry));
});

afterEach(async () => {
  Object.assign(_captureDeps, originalDeps);
  _unifiedExecutorDeps.runIteration = origRunIteration;
  _unifiedExecutorDeps.runWorkflowPreflight = origRunWorkflowPreflight;
  resetLogger();
  await Promise.all(tempDirs.map(cleanupTempDir));
  tempDirs.length = 0;
});

function makeOptions(overrides: Partial<RunnerExecutionOptions> = {}): RunnerExecutionOptions {
  const runtime = makeMockRuntime();
  return {
    prdPath: "/tmp/nax-runner-exec-capture/prd.json",
    workdir: "/tmp/nax-runner-exec-capture",
    config: makeNaxConfig(),
    hooks: { hooks: {}, _skipGlobal: false },
    feature: "feat-capture",
    featureDir: undefined,
    dryRun: false,
    useBatch: false,
    statusWriter: makeStatusWriter(),
    statusFile: "/tmp/nax-runner-exec-capture/status.json",
    logFilePath: undefined,
    runId: "run-capture",
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    formatterMode: "quiet",
    headless: false,
    parallel: undefined,
    abortSignal: new AbortController().signal,
    sessionManager: runtime.sessionManager,
    runtime,
    agentManager: runtime.agentManager,
    pluginProviderCache: undefined,
    providerWeightsCache: undefined,
    ...overrides,
  };
}

/**
 * Stub the unified executor's per-story iteration so `executeUnified` returns
 * quickly. `onCall` is recorded before the stub answers, so a test can assert
 * the baseline capture ran first.
 */
function stubIteration(returns: PRD, onCall: () => void = () => {}): void {
  _unifiedExecutorDeps.runIteration = async () => {
    onCall();
    return {
      prd: returns,
      storiesCompletedDelta: 0,
      costDelta: 0,
      prdDirty: false,
      finalAction: "continue",
    };
  };
}

const passedPRD = (feature = "feat-capture"): PRD =>
  makePRD({ feature, userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] });

const pendingPRD = (feature = "feat-capture"): PRD =>
  makePRD({ feature, userStories: [makeStory({ id: "US-001", status: "pending", passes: false })] });

describe("runExecutionPhase — AC11: invokes captureRunBaseline exactly once", () => {
  test("AC11: capture is invoked exactly once before the first story pipeline dispatch with run config + workdir", async () => {
    const writes: Array<{ root: string; featureId: string }> = [];
    _captureDeps.writeRunBaseline = async (root, featureId) => {
      writes.push({ root, featureId });
    };
    stubIteration(passedPRD());

    const options = makeOptions();
    await runExecutionPhase(options, pendingPRD(), makePluginRegistry());

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ root: options.workdir, featureId: options.feature });
  });

  test("AC11 boundary: capture is invoked with the run config and workdir from RunnerExecutionOptions", async () => {
    const writes: Array<{ root: string; featureId: string }> = [];
    _captureDeps.writeRunBaseline = async (root, featureId) => {
      writes.push({ root, featureId });
    };
    stubIteration(passedPRD("feat-custom-name"));

    const workdir = "/tmp/custom-workdir-99";
    const feature = "feat-custom-name";
    await runExecutionPhase(makeOptions({ workdir, feature }), pendingPRD(feature), makePluginRegistry());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.root).toBe(workdir);
    expect(writes[0]?.featureId).toBe(feature);
  });
});

describe("runExecutionPhase — US-001: no pending story skips the run-start capture", () => {
  let writes: unknown[][] = [];
  let clears: unknown[][] = [];

  beforeEach(() => {
    writes = [];
    clears = [];
    _captureDeps.writeRunBaseline = async (...args) => {
      writes.push(args);
    };
    _captureDeps.clearStoryBaselines = async (...args) => {
      clears.push(args);
    };
  });

  test("AC-1: a passed story makes no baseline write and no story-baseline clear", async () => {
    stubIteration(passedPRD());

    await runExecutionPhase(makeOptions(), passedPRD(), makePluginRegistry());

    expect(writes).toEqual([]);
    expect(clears).toEqual([]);
  });

  test("AC-2: the skip is logged once at info with the feature name", async () => {
    stubIteration(passedPRD("feat-skip"));

    await runExecutionPhase(makeOptions({ feature: "feat-skip" }), passedPRD("feat-skip"), makePluginRegistry());

    const skips = logEntries.filter((e) => e.message === "Run-start test baseline skipped — no story to run");
    expect(skips).toHaveLength(1);
    expect(skips[0]?.level).toBe("info");
    expect(skips[0]?.stage).toBe("execution");
    expect(skips[0]?.data).toEqual({ feature: "feat-skip" });
  });

  test("AC-3: one pending story captures exactly once, before the first iteration", async () => {
    const order: string[] = [];
    _captureDeps.writeRunBaseline = async () => {
      order.push("capture");
    };
    stubIteration(passedPRD(), () => order.push("iterate"));

    await runExecutionPhase(makeOptions(), pendingPRD(), makePluginRegistry());

    expect(order.filter((step) => step === "capture")).toHaveLength(1);
    expect(order.indexOf("capture")).toBe(0);
    expect(order.indexOf("iterate")).toBeGreaterThan(order.indexOf("capture"));
  });

  test("AC-4: a dry run over a pending story captures nothing", async () => {
    stubIteration(passedPRD());

    await runExecutionPhase(makeOptions({ dryRun: true }), pendingPRD(), makePluginRegistry());

    expect(writes).toEqual([]);
  });

  test("AC-5: decomposed and regression-failed stories are not pending, so nothing is captured", async () => {
    stubIteration(passedPRD());

    await runExecutionPhase(
      makeOptions(),
      makePRD({
        userStories: [
          makeStory({ id: "US-001", status: "decomposed", passes: false }),
          makeStory({ id: "US-002", status: "regression-failed", passes: false }),
        ],
      }),
      makePluginRegistry(),
    );

    expect(writes).toEqual([]);
  });

  test("AC-20: an existing test-baseline.json stays byte-identical when no story is pending", async () => {
    const root = makeTempDir("nax-capture-skip-");
    tempDirs.push(root);
    const feature = "feat-byte-identical";
    const path = join(featureDir(root, feature), "test-baseline.json");
    const original = '{\n  "capturedAt": "2020-01-01T00:00:00.000Z",\n  "entries": []\n}\n';
    await Bun.write(path, original);
    // The file writers stay real: with no resolvable command the capture would
    // persist a `no-baseline` marker over the file above, which is exactly the
    // damage this AC forbids.
    Object.assign(_captureDeps, originalDeps);
    _captureDeps.resolveTestCommands = async () => undefined;
    stubIteration(passedPRD(feature));

    await runExecutionPhase(
      makeOptions({ workdir: root, feature }),
      makePRD({ feature, userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] }),
      makePluginRegistry(),
    );

    expect(await Bun.file(path).text()).toBe(original);
  });
});
