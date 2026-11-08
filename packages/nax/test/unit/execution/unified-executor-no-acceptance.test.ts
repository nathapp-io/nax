/**
 * `executeUnified` runs no acceptance setup and no post-run acceptance stage —
 * pipeline-post-run-delete US-005, made structural by pipeline-acceptance-
 * isolation-delete US-003 (the config section they were gated on no longer
 * exists).
 *
 * These tests pin the invariant at the seam a caller actually observes: an
 * ordinary run must enter neither block, on either exit branch. The exit
 * reasons plus the recorded stage names are observable behaviour rather than a
 * grep of the source, so a re-introduced stage shows up here — including one
 * renamed in the logs, because `stage:enter` is asserted separately.
 *
 * Two seams are observed:
 *   - the captured logger, for the two block-entry messages that only the
 *     removed blocks emitted;
 *   - `ctx.eventEmitter`, for `stage:enter` names (`pipeline/runner.ts`), so a
 *     re-introduced stage would show up even if it were renamed in the logs.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { stopHeartbeat } from "@/execution/crash-recovery";
import type { StorySelection } from "@/execution/story-selector";
import { _unifiedExecutorDeps, executeUnified, type SequentialExecutionContext } from "@/execution/unified-executor";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { PipelineEventEmitter } from "@/pipeline/events";
import type { PRD } from "@/prd/types";

/** Only the removed pre-run acceptance block emitted this message. */
const PRE_RUN_MESSAGE = "Running pre-run pipeline (acceptance test setup)";
/** Only the removed post-run acceptance block emitted this message. */
const POST_RUN_MESSAGE = "Running post-run pipeline (acceptance tests)";
/** The stage names the deleted acceptance stages registered with the pipeline runner. */
const REMOVED_STAGE_NAMES = ["acceptance-setup", "acceptance"];

const original = { ..._unifiedExecutorDeps };

let dir: string;
let logEntries: LogEntry[];

/** The run config every case below executes with. */
function runConfig(): NaxConfig {
  return makeNaxConfig({
    execution: { mode: "pipeline", iterationDelayMs: 0 },
    autoMode: { escalation: { enabled: false } },
  });
}

function makeCtx(emitter: PipelineEventEmitter): SequentialExecutionContext {
  return {
    ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: dir }) }),
    config: runConfig(),
    prdPath: join(dir, "prd.json"),
    workdir: dir,
    featureDir: dir,
    feature: "f",
    hooks: { hooks: {} },
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    eventEmitter: emitter,
    runId: "no-acceptance",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
  };
}

function pendingPrd(): PRD {
  return makePRD({ userStories: [makeStory({ id: "US-001", status: "pending", passes: false })] });
}

/** Marks the single pending story passed, so the loop reaches the completed branch. */
function stubIterationCompletesStory(): void {
  _unifiedExecutorDeps.runIteration = mock(
    async (_ctx: SequentialExecutionContext, current: PRD, selection: StorySelection) => ({
      prd: {
        ...current,
        userStories: current.userStories.map((s) =>
          s.id === selection.story.id ? { ...s, status: "passed" as const, passes: true } : s,
        ),
      },
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }),
  );
}

/** Leaves the story pending and the PRD clean, so the loop ends at max-iterations. */
function stubIterationLeavesStoryPending(): void {
  _unifiedExecutorDeps.runIteration = mock(async (_ctx: SequentialExecutionContext, current: PRD) => ({
    prd: current,
    storiesCompletedDelta: 0,
    costDelta: 0,
    prdDirty: false,
  }));
}

function messages(): string[] {
  return logEntries.map((entry) => entry.message);
}

function stageEnterNames(emitter: PipelineEventEmitter): string[] {
  const names: string[] = [];
  emitter.on("stage:enter", (stage) => names.push(stage));
  return names;
}

beforeEach(() => {
  dir = makeTempDir("nax-no-acceptance-");
  // The logger singleton is process-wide; reset first so a previous file's
  // instance does not make initLogger throw.
  resetLogger();
  logEntries = [];
  initLogger({ level: "silent" });
  addSink((entry) => logEntries.push(entry));
  _unifiedExecutorDeps.runWorkflowPreflight = async () => {};
});

afterEach(() => {
  Object.assign(_unifiedExecutorDeps, original);
  stopHeartbeat();
  pipelineEventBus.clear();
  resetLogger();
  cleanupTempDir(dir);
});

describe("executeUnified — a run executes no acceptance setup", () => {
  test("AC-1: returns exit reason completed when the stubbed iteration marks the pending story passed", async () => {
    const emitter = new PipelineEventEmitter();
    stubIterationCompletesStory();

    const result = await executeUnified(makeCtx(emitter), pendingPrd());

    expect(result.exitReason).toBe("completed");
    expect(result.storiesCompleted).toBe(1);
    expect(result.prd.userStories[0]?.status).toBe("passed");
  });

  test("AC-2: never logs the pre-run acceptance setup message", async () => {
    const emitter = new PipelineEventEmitter();
    stubIterationCompletesStory();

    await executeUnified(makeCtx(emitter), pendingPrd());

    expect(messages().filter((message) => message.includes(PRE_RUN_MESSAGE))).toEqual([]);
  });
});

describe("executeUnified — a run executes no post-run acceptance stage", () => {
  test("AC-3: returns exit reason max-iterations when the iteration leaves the story pending", async () => {
    const emitter = new PipelineEventEmitter();
    stubIterationLeavesStoryPending();

    const result = await executeUnified(makeCtx(emitter), pendingPrd());

    expect(result.exitReason).toBe("max-iterations");
    expect(result.prd.userStories[0]?.status).toBe("pending");
    expect(_unifiedExecutorDeps.runIteration).toHaveBeenCalled();
  });

  test("AC-4: never logs the post-run acceptance message", async () => {
    const emitter = new PipelineEventEmitter();
    stubIterationLeavesStoryPending();

    await executeUnified(makeCtx(emitter), pendingPrd());

    expect(messages().filter((message) => message.includes(POST_RUN_MESSAGE))).toEqual([]);
  });
});

describe("executeUnified — no acceptance stage is entered through the event emitter", () => {
  test("AC-5: emits no stage:enter naming a deleted acceptance stage, in either exit branch", async () => {
    const completedEmitter = new PipelineEventEmitter();
    const completedStages = stageEnterNames(completedEmitter);
    stubIterationCompletesStory();
    const completed = await executeUnified(makeCtx(completedEmitter), pendingPrd());
    expect(completed.exitReason).toBe("completed");

    const exhaustedEmitter = new PipelineEventEmitter();
    const exhaustedStages = stageEnterNames(exhaustedEmitter);
    stubIterationLeavesStoryPending();
    const exhausted = await executeUnified(makeCtx(exhaustedEmitter), pendingPrd());
    expect(exhausted.exitReason).toBe("max-iterations");

    for (const name of REMOVED_STAGE_NAMES) {
      expect(completedStages).not.toContain(name);
      expect(exhaustedStages).not.toContain(name);
    }
  });
});
