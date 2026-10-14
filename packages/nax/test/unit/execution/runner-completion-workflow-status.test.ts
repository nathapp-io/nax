/**
 * US-004: the completion phase persists the feature workflow's verdict.
 *
 * Workflow mode never writes `postRun.finish`, so a caller that reads status.json the
 * way it reads a pipeline run used to see a failed feature workflow reported as
 * `completed`. After the end phase, a run the completion phase called "completed"
 * becomes "failed" when the feature workflow did not pass — and only then: pipeline
 * mode and a passing workflow must not add a `setRunStatus` call.
 *
 * The four verdict paths are driven through `runCompletionPhase` itself (with
 * `handleRunCompletion` and the feature workflow faked, as in the workflow-duration
 * suite), so the assertion is on the `status.json` a reader actually gets.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSpawn,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { RunCompletionResult } from "@/execution/lifecycle/run-completion";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import { StatusWriter } from "@/execution/status-writer";
import { _workflowEndReportDeps } from "@/execution/workflow-end-report";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD } from "@/prd";
import { _gitDeps } from "@/utils/git";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const origDeps = { ..._runnerCompletionDeps };
const origReport = { ..._workflowEndReportDeps };
const origGit = _gitDeps.spawn;

const base: RunCompletionResult = {
  durationMs: 100,
  runCompletedAt: new Date().toISOString(),
  reportedTotal: 0,
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
  pluginGateFailed: false,
};

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

function configFor(mode: "workflow" | "pipeline"): NaxConfig {
  return makeNaxConfig({
    acceptance: { enabled: false },
    execution: { mode, regressionGate: { mode: "disabled" } },
  });
}

/** A complete PRD — `writeFinalFeatureStatus` classifies it "completed". */
function okPrd(): PRD {
  return makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] });
}

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  statusWriter: RunnerCompletionOptions["statusWriter"],
  dir: string,
  over: Partial<RunnerCompletionOptions> = {},
): RunnerCompletionOptions {
  const runtime = makeMockRuntime({ config, workdir: dir });
  return {
    config,
    hooks: { hooks: {}, _skipGlobal: false },
    feature: "test-feature",
    workdir: dir,
    statusFile: join(dir, "status.json"),
    logFilePath: undefined,
    runId: "run-001",
    startedAt: new Date().toISOString(),
    startTime: Date.now() - 1000,
    formatterMode: "quiet",
    headless: false,
    prd,
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter,
    pluginRegistry: makePluginRegistry(),
    prdPath: join(dir, "prd.json"),
    runtime,
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
    ...over,
  };
}

/** A real writer, already reporting the "completed" the completion phase sets. */
function completedWriter(dir: string, config: NaxConfig, prd: PRD): StatusWriter {
  const writer = new StatusWriter(join(dir, "status.json"), config, {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    dryRun: false,
    startTimeMs: Date.now(),
    pid: process.pid,
  });
  writer.setPrd(prd);
  writer.setRunStatus("completed");
  return writer;
}

async function writtenStatus(dir: string): Promise<{ run: { status: string } }> {
  return (await Bun.file(join(dir, "status.json")).json()) as { run: { status: string } };
}

beforeEach(() => {
  _runnerCompletionDeps.handleRunCompletion = mock(async (o) => ({
    ...base,
    ...(o.deferRunCompleteLog ? { logRunComplete: () => {} } : {}),
  }));
  _workflowEndReportDeps.readSummary = async () => null;
  _workflowEndReportDeps.saveDuration = async () => true;
  _gitDeps.spawn = makeSpawn().spawn;
});

afterEach(async () => {
  Object.assign(_runnerCompletionDeps, origDeps);
  Object.assign(_workflowEndReportDeps, origReport);
  _gitDeps.spawn = origGit;
  pipelineEventBus.clear();
  mock.restore();
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

// ---------------------------------------------------------------------------
// AC: the persisted status.json carries the workflow's verdict
// ---------------------------------------------------------------------------

describe("runCompletionPhase — final run status honours the feature workflow (US-004)", () => {
  test("a failed feature workflow turns the persisted run status into failed", async () => {
    const dir = makeDir("wf-status-failed-");
    const config = configFor("workflow");
    const prd = okPrd();
    const writer = completedWriter(dir, config, prd);
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => ({
      passed: false,
      outcome: "draft" as const,
      reasons: ["gates red: test"],
    }));

    await runCompletionPhase(makeOpts(config, prd, writer, dir));

    expect(writer.runStatus).toBe("failed");
    expect((await writtenStatus(dir)).run.status).toBe("failed");
  });

  test("a passing feature workflow keeps a draft run completed", async () => {
    const dir = makeDir("wf-status-passing-");
    const config = configFor("workflow");
    const prd = okPrd();
    const writer = completedWriter(dir, config, prd);
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => ({
      passed: true,
      outcome: "draft" as const,
      reasons: ["CI failed"],
    }));

    await runCompletionPhase(makeOpts(config, prd, writer, dir));

    expect((await writtenStatus(dir)).run.status).toBe("completed");
  });

  test("a throwing feature workflow leaves the persisted run status failed", async () => {
    const dir = makeDir("wf-status-threw-");
    const config = configFor("workflow");
    const prd = okPrd();
    const writer = completedWriter(dir, config, prd);
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => {
      throw new Error("workflow exploded");
    });

    await runCompletionPhase(makeOpts(config, prd, writer, dir));

    expect((await writtenStatus(dir)).run.status).toBe("failed");
  });

  test("a cost-limit stop is not downgraded further by a failed workflow", async () => {
    const dir = makeDir("wf-status-cost-limit-");
    const config = configFor("workflow");
    const prd = okPrd();
    const writer = completedWriter(dir, config, prd);
    writer.setRunStatus("cost-limit");
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => ({
      passed: false,
      outcome: "local-only" as const,
      reasons: ["gates red: test"],
    }));

    await runCompletionPhase(makeOpts(config, prd, writer, dir));

    expect((await writtenStatus(dir)).run.status).toBe("cost-limit");
  });
});

// ---------------------------------------------------------------------------
// AC: the downgrade is the only extra setRunStatus call, and only when it applies
// ---------------------------------------------------------------------------

describe("runCompletionPhase — no redundant setRunStatus after the end phase (US-004)", () => {
  test("pipeline mode makes no setRunStatus call after the end phase", async () => {
    const dir = makeDir("wf-status-pipeline-");
    const config = configFor("pipeline");
    const prd = okPrd();
    const featureDir = join(dir, "feature");
    mkdirSync(featureDir, { recursive: true });
    const statusWriter = makeStatusWriter();
    _runnerCompletionDeps.runFinishPhase = mock(async () => null);

    await runCompletionPhase(makeOpts(config, prd, statusWriter, dir, { featureDir }));

    // The one writeFinalFeatureStatus makes; anything later would be the downgrade's.
    expect(statusWriter.setRunStatus).toHaveBeenLastCalledWith("completed");
    expect(statusWriter.setRunStatus).toHaveBeenCalledTimes(1);
  });

  test("workflow mode with a passing workflow makes no setRunStatus call after the end phase", async () => {
    const dir = makeDir("wf-status-passing-calls-");
    const config = configFor("workflow");
    const prd = okPrd();
    const featureDir = join(dir, "feature");
    mkdirSync(featureDir, { recursive: true });
    const statusWriter = makeStatusWriter();
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => ({
      passed: true,
      outcome: "ready" as const,
      reasons: [],
    }));

    await runCompletionPhase(makeOpts(config, prd, statusWriter, dir, { featureDir }));

    expect(statusWriter.setRunStatus).toHaveBeenLastCalledWith("completed");
    expect(statusWriter.setRunStatus).toHaveBeenCalledTimes(1);
  });

  test("workflow mode with a failed workflow adds one setRunStatus call, for failed", async () => {
    const dir = makeDir("wf-status-failed-calls-");
    const config = configFor("workflow");
    const prd = okPrd();
    const writer = completedWriter(dir, config, prd);
    const setRunStatus = spyOn(writer, "setRunStatus");
    _runnerCompletionDeps.runWorkflowFeature = mock(async () => ({
      passed: false,
      outcome: "draft" as const,
      reasons: ["gates red: test"],
    }));

    await runCompletionPhase(makeOpts(config, prd, writer, dir));

    expect(setRunStatus).toHaveBeenCalledTimes(1);
    expect(setRunStatus).toHaveBeenLastCalledWith("failed");
  });
});
