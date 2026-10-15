import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeDispatchContext,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStory,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import type { SequentialExecutionContext } from "@/execution/executor-types";
import { _iterationRunnerDeps, runIteration } from "@/execution/iteration-runner";
import type { NaxStatusFile } from "@/execution/status-file";
import { StatusWriter } from "@/execution/status-writer";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { buildStoryEnv } from "@/workflow/stage-env";

let dir: string;
let path: string;
let writers: StatusWriter[];
let runtimes: ReturnType<typeof makeMockRuntime>[];
const originalDeps = { ..._iterationRunnerDeps };
const config = makeNaxConfig({ execution: { storyIsolation: "shared", iterationDelayMs: 0 } });
const story = makeStory();
const prd = makePRD({ userStories: [story] });
const routing = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" } as const;
const timestamp = "2026-10-15T00:00:00.000Z";

beforeEach(() => {
  dir = makeTempDir("live-phase-");
  path = join(dir, "status.json");
  writers = [];
  runtimes = [];
  resetLogger();
  initLogger({ level: "silent" });
});
afterEach(async () => {
  Object.assign(_iterationRunnerDeps, originalDeps);
  // Also drain writes on assertion failures, before removing their directories.
  await Promise.all(writers.map((writer) => writer.idle()));
  await Promise.all(runtimes.map((runtime) => runtime.close()));
  resetLogger();
  cleanupTempDir(dir);
});

function writer(options: { current?: boolean; prd?: boolean; rejectedPath?: boolean } = {}): StatusWriter {
  const sw = new StatusWriter(options.rejectedPath ? `${dir}/../rejected-status.json` : path, config, {
    runId: "live-run",
    feature: "live-feature",
    startedAt: timestamp,
    dryRun: false,
    startTimeMs: Date.now(),
    pid: process.pid,
  });
  writers.push(sw);
  if (options.prd !== false) sw.setPrd(prd);
  if (options.current !== false)
    sw.setCurrentStory({
      storyId: story.id,
      title: story.title,
      complexity: "simple",
      tddStrategy: "test-after",
      model: "fast",
      attempt: 1,
      phase: "routing",
    });
  return sw;
}
async function read(): Promise<NaxStatusFile> {
  return Bun.file(path).json();
}
async function verifyAfterUpdate(): Promise<NaxStatusFile> {
  const sw = writer();
  await sw.update(1.5, 3);
  sw.setPhase("verify");
  await sw.idle();
  return read();
}

describe("StatusWriter live phase persistence", () => {
  test("AC-1 persists current.phase without another update", async () => {
    expect((await verifyAfterUpdate()).current?.phase).toBe("verify");
  });
  test("AC-2 retains the last update cost", async () => {
    expect((await verifyAfterUpdate()).cost.spent).toBe(1.5);
  });
  test("AC-3 retains the last update iterations", async () => {
    expect((await verifyAfterUpdate()).iterations).toBe(3);
  });
  test("AC-4 preserves reviewSummary and all other current story fields", async () => {
    const sw = writer();
    const reviewSummary = { semantic: { blocking: 1, advisory: 0 } };
    sw.setReviewSummary(reviewSummary);
    const before = sw.getSnapshot(0, 0)?.currentStory;
    assertDefined(before);
    sw.setPhase("review");
    await sw.idle();
    expect(sw.getSnapshot(0, 0)?.currentStory).toEqual({ ...before, phase: "review" });
    expect((await read()).current?.reviewSummary).toEqual(reviewSummary);
  });
  test("AC-5 retains lastHeartbeat across phase writes and later updates", async () => {
    const sw = writer();
    await sw.update(0, 1, { lastHeartbeat: timestamp });
    await sw.update(0, 2);
    sw.setPhase("verify");
    await sw.idle();
    expect((await read()).lastHeartbeat).toBe(timestamp);
  });
  test("AC-6 flush writes with last update arguments, not the monotonic cost getter", async () => {
    const sw = writer();
    await sw.update(5, 3);
    await sw.update(2, 4);
    // Prove flush actually writes, rather than just reading the previous update.
    await Bun.file(path).delete();
    await sw.flush();
    expect((await read()).cost.spent).toBe(2);
    expect((await read()).iterations).toBe(4);
    expect(sw.lastTotalCost).toBe(5);
  });
  test("AC-7 no current story means no queued write", async () => {
    const sw = writer({ current: false });
    sw.setPhase("verify");
    await sw.idle();
    expect(await Bun.file(path).exists()).toBe(false);
  });
  test.each(["acceptance", "regression"] as const)("AC-8/9 persists %s running on transition", async (phase) => {
    const sw = writer();
    await sw.update(0, 1);
    if (phase === "acceptance") sw.setPostRunPhase("acceptance", { status: "running" });
    else sw.setPostRunPhase("regression", { status: "running" });
    await sw.idle();
    expect((await read()).postRun?.[phase].status).toBe("running");
  });
  test("AC-10 persists workflow transition", async () => {
    const sw = writer();
    await sw.update(0, 1);
    sw.setWorkflowStatus({ step: "publish", stories: {} });
    await sw.idle();
    expect((await read()).workflow?.step).toBe("publish");
  });
  test("AC-11 setter does not throw for a rejected path", async () => {
    const sw = writer({ rejectedPath: true });
    expect(() => sw.setPhase("verify")).not.toThrow();
    await sw.idle();
  });
  test("AC-12 idle resolves after a rejected path write", async () => {
    const sw = writer({ rejectedPath: true });
    sw.setPhase("verify");
    await expect(sw.idle()).resolves.toBeUndefined();
  });
  test("AC-13 crash overrides survive subsequent setter and explicit flush", async () => {
    const sw = writer();
    sw.setRunStatus("crashed");
    await sw.update(0, 1, { crashedAt: timestamp, crashSignal: "SIGTERM" });
    sw.setPhase("verify");
    await sw.flush();
    await sw.idle();
    expect((await read()).run.crashedAt).toBe(timestamp);
    expect((await read()).run.crashSignal).toBe("SIGTERM");
  });
  test("AC-19 logs the queued failure before idle resolves", async () => {
    const logs: LogEntry[] = [];
    addSink((entry) => logs.push(entry));
    const sw = writer({ rejectedPath: true });
    sw.setPhase("verify");
    await sw.idle();
    expect(logs).toContainEqual(
      expect.objectContaining({
        stage: "status-file",
        level: "warn",
        message: "Failed to write status file (non-fatal)",
      }),
    );
    expect(logs[0]?.data?.error).toBe("Invalid status file path: path traversal detected");
  });
  test("AC-20 no current story remains null in memory", async () => {
    const sw = writer({ current: false });
    sw.setPhase("verify");
    expect(sw.getSnapshot(0, 0)?.currentStory).toBeNull();
    await sw.idle();
  });
  test("flush without PRD and idle alone write nothing; first flush defaults to zero", async () => {
    const sw = writer({ prd: false });
    await sw.flush();
    await sw.idle();
    expect(await Bun.file(path).exists()).toBe(false);
    sw.setPrd(prd);
    await sw.idle();
    expect(await Bun.file(path).exists()).toBe(false);
    await sw.flush();
    expect((await read()).iterations).toBe(0);
    expect((await read()).cost.spent).toBe(0);
  });
});

describe("live phase consumer seams", () => {
  test("AC-16 runIteration constructs a callback wired to the real StatusWriter", async () => {
    const sw = writer();
    const runtime = makeMockRuntime({ config, workdir: dir });
    runtimes.push(runtime);
    const ctx: SequentialExecutionContext = {
      config,
      prdPath: join(dir, "prd.json"),
      workdir: dir,
      hooks: { hooks: {} },
      feature: prd.feature,
      dryRun: false,
      useBatch: false,
      pluginRegistry: makePluginRegistry(),
      statusWriter: sw,
      runId: runtime.runId,
      startTime: Date.now(),
      batchPlan: [],
      interactionChain: null,
      ...makeDispatchContext({ runtime }),
    };
    let observed: string | undefined;
    _iterationRunnerDeps.runPipeline = async (_stages, context) => {
      context.reportPhase?.("implement");
      observed = ctx.statusWriter.getSnapshot(0, 0)?.currentStory?.phase;
      return { success: true, finalAction: "complete", context };
    };
    await runIteration(ctx, prd, { story, storiesToExecute: [story], routing, isBatchExecution: false }, 1, 0, []);
    expect(observed).toBe("implement");
    await sw.idle();
  });
  test("AC-17 returned workflow sink reports its string phase", async () => {
    const reportPhase = mock(() => {});
    const runtime = makeMockRuntime({ config, workdir: dir });
    runtimes.push(runtime);
    const ctx = makeTestContext({
      config,
      rootConfig: config,
      runtime,
      workdir: dir,
      projectDir: dir,
      storyGitRef: "base123",
      reportPhase,
    });
    const { env } = await buildStoryEnv(ctx, makeMockCallContext({ runtime }));
    await env.sink.update({ phase: "review" });
    expect(reportPhase).toHaveBeenCalledTimes(1);
    expect(reportPhase).toHaveBeenCalledWith("review");
  });
  test("AC-18 returned workflow sink ignores patches without phase", async () => {
    const reportPhase = mock(() => {});
    const runtime = makeMockRuntime({ config, workdir: dir });
    runtimes.push(runtime);
    const ctx = makeTestContext({
      config,
      rootConfig: config,
      runtime,
      workdir: dir,
      projectDir: dir,
      storyGitRef: "base123",
      reportPhase,
    });
    const { env } = await buildStoryEnv(ctx, makeMockCallContext({ runtime }));
    await env.sink.update({ phase: "review" });
    expect(reportPhase).toHaveBeenCalledWith("review");
    reportPhase.mockClear();
    await env.sink.update({ round: 2 });
    expect(reportPhase).not.toHaveBeenCalled();
  });
});
