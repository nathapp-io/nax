/**
 * US-001 — the deferred `run:completed`.
 *
 * `deferRunCompletedEvent` holds the event back until the caller knows the whole run (the end
 * phase has closed), independently of `deferRunCompleteLog`. When a phase after the hold-back
 * point rejects, `handleRunCompletion` emits the event itself — with the figures it holds — and
 * drains the bus before the error propagates, so the event is never lost and its async
 * subscribers are never cut short.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  assertDefined,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
  makeStatusWriter,
  makeStory,
  waitForCondition,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { _runCompletionDeps, handleRunCompletion, type RunCompletionOptions } from "@/execution/lifecycle";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { pipelineEventBus, type RunCompletedEvent } from "@/pipeline";
import { countStories, type PRD } from "@/prd";

const WORKDIR = `/tmp/nax-test-run-completed-deferred-${randomUUID()}`;

const PIPELINE = makeNaxConfig({ execution: { mode: "pipeline", regressionGate: { mode: "disabled" } } });
const WORKFLOW = makeNaxConfig({ execution: { mode: "workflow", regressionGate: { mode: "disabled" } } });

/** One story of each status countStories distinguishes, so the event's counts are all different. */
function runPRD(): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    userStories: [
      makeStory({ id: "US-001", status: "passed", passes: true }),
      makeStory({ id: "US-002", status: "failed" }),
      makeStory({ id: "US-003", status: "skipped" }),
      makeStory({ id: "US-004", status: "paused" }),
      makeStory({ id: "US-005", status: "pending" }),
    ],
  };
}

function opts(config: NaxConfig, over: Partial<RunCompletionOptions> = {}): RunCompletionOptions {
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date(0).toISOString(),
    prd: runPRD(),
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 5,
    iterations: 1,
    startTime: Date.now() - 50,
    workdir: WORKDIR,
    statusWriter: makeStatusWriter(),
    config,
    runtime: makeMockRuntime(),
    agentManager: makeMockAgentManager(),
    sessionManager: makeSessionManager(),
    abortSignal: new AbortController().signal,
    ...over,
  };
}

/** A `run:completed` collector on the shared bus. Call `stop()` when the test is done. */
function captureCompleted(): { events: RunCompletedEvent[]; stop: () => void } {
  const events: RunCompletedEvent[] = [];
  const stop = pipelineEventBus.on("run:completed", (ev) => {
    events.push(ev);
  });
  return { events, stop };
}

/** The `run.complete` summary line `logRunCompletion` writes. */
const completes = (): LogEntry[] =>
  logs.filter((e) => e.stage === "run.complete" && e.message === "Feature execution completed");

const origDeps = { ..._runCompletionDeps };
let logs: LogEntry[] = [];
let removeSink: (() => void) | undefined;

beforeEach(() => {
  pipelineEventBus.clear();
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  removeSink = addSink((entry) => logs.push(entry));
});

afterEach(() => {
  removeSink?.();
  removeSink = undefined;
  resetLogger();
  pipelineEventBus.clear();
  Object.assign(_runCompletionDeps, origDeps);
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC-1 to AC-3: deferring the event, independently of the log line
// ---------------------------------------------------------------------------

describe("handleRunCompletion — deferring run:completed (AC-1 to AC-3)", () => {
  test("AC-1: with deferRunCompletedEvent no event is emitted and the result carries an emitter", async () => {
    const { events, stop } = captureCompleted();
    try {
      const result = await handleRunCompletion(opts(PIPELINE, { deferRunCompletedEvent: true }));

      expect(events).toHaveLength(0);
      expect(result.emitRunCompleted).toBeFunction();
    } finally {
      stop();
    }
  });

  test("AC-2 (regression anchor): without deferRunCompletedEvent exactly one event is emitted and there is no emitter", async () => {
    const { events, stop } = captureCompleted();
    try {
      const result = await handleRunCompletion(opts(PIPELINE));

      expect(events).toHaveLength(1);
      expect(result.emitRunCompleted).toBeUndefined();
    } finally {
      stop();
    }
  });

  test("AC-3: the two deferral flags are independent — the log line is written while the event is held back", async () => {
    const { events, stop } = captureCompleted();
    try {
      await handleRunCompletion(opts(PIPELINE, { deferRunCompletedEvent: true }));

      expect(completes()).toHaveLength(1);
      expect(events).toHaveLength(0);
    } finally {
      stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4, AC-5: what the deferred emitter publishes
// ---------------------------------------------------------------------------

describe("handleRunCompletion — the deferred emitter (AC-4, AC-5)", () => {
  test("AC-4: the caller's whole-run figures overlay the phase-5 payload, whose story counts survive", async () => {
    const prd = runPRD();
    const { events, stop } = captureCompleted();
    try {
      const result = await handleRunCompletion(opts(PIPELINE, { deferRunCompletedEvent: true, prd }));
      assertDefined(result.emitRunCompleted, "the deferred run:completed emitter");

      result.emitRunCompleted({
        durationMs: 9_000,
        storiesDurationMs: 8_000,
        totalCost: 4.94,
        workflowPassed: true,
        url: "https://github.com/o/r/pull/295",
        reasons: [],
      });

      expect(events).toHaveLength(1);
      const [event] = events;
      assertDefined(event, "the emitted run:completed event");
      const counts = countStories(prd);
      // The fixture must exercise every count distinctly, or the four assertions below are vacuous.
      expect([counts.total, counts.passed, counts.failed, counts.skipped, counts.paused]).toEqual([5, 1, 1, 1, 1]);

      expect(event.durationMs).toBe(9_000);
      expect(event.totalCost).toBe(4.94);
      expect(event.workflowPassed).toBe(true);
      expect(event.url).toBe("https://github.com/o/r/pull/295");
      expect(event.passedStories).toBe(counts.passed);
      expect(event.failedStories).toBe(counts.failed);
      expect(event.skippedStories).toBe(counts.skipped);
      expect(event.pausedStories).toBe(counts.paused);
    } finally {
      stop();
    }
  });

  test("AC-5: a failed verdict carries its reasons onto the event", async () => {
    const { events, stop } = captureCompleted();
    try {
      const result = await handleRunCompletion(opts(WORKFLOW, { deferRunCompletedEvent: true }));
      assertDefined(result.emitRunCompleted, "the deferred run:completed emitter");

      result.emitRunCompleted({
        durationMs: 9_000,
        storiesDurationMs: 8_000,
        totalCost: 4.94,
        workflowPassed: false,
        reasons: ["final gates red: lint"],
      });

      expect(events).toHaveLength(1);
      const [event] = events;
      assertDefined(event, "the emitted run:completed event");
      expect(event.workflowPassed).toBe(false);
      expect(event.reasons).toEqual(["final gates red: lint"]);
    } finally {
      stop();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6, AC-7, AC-13, AC-14, AC-15: a rejection after the hold-back point
// ---------------------------------------------------------------------------

/** The two phases that can reject after phase 5: 7.5 (MCP adoption) and 8 (final status). */
const LATE_PHASES = ["7.5", "8"] as const;
type LatePhase = (typeof LATE_PHASES)[number];

/**
 * Make the named phase reject, and report the message the rejection carries. Phase 8 is
 * reached only through `statusWriter.update`, so that is what is made to reject there. Each
 * call first restores phase 7.5's seam, so a caller looping over both phases sees only the
 * rejection it asked for.
 */
function rejectLatePhase(phase: LatePhase): { over: Partial<RunCompletionOptions>; message: string } {
  _runCompletionDeps.summarizeMcpAdoptionPhase = origDeps.summarizeMcpAdoptionPhase;
  if (phase === "7.5") {
    _runCompletionDeps.summarizeMcpAdoptionPhase = mock(async () => {
      throw new Error("mcp down");
    }) as typeof _runCompletionDeps.summarizeMcpAdoptionPhase;
    return { over: {}, message: "mcp down" };
  }
  return {
    over: {
      statusWriter: makeStatusWriter({
        update: mock(async () => {
          throw new Error("status down");
        }),
      }),
    },
    message: "status down",
  };
}

describe("handleRunCompletion — a rejection after the hold-back point (AC-6, AC-7, AC-13 to AC-15)", () => {
  test("AC-6: a phase-7.5 rejection emits the held-back event exactly once, from the catch, before it propagates", async () => {
    const order: string[] = [];
    _runCompletionDeps.summarizeMcpAdoptionPhase = mock(async () => {
      order.push("phase-7.5");
      throw new Error("mcp down");
    }) as typeof _runCompletionDeps.summarizeMcpAdoptionPhase;
    const stop = pipelineEventBus.on("run:completed", () => {
      order.push("run:completed");
    });

    try {
      await expect(handleRunCompletion(opts(WORKFLOW, { deferRunCompletedEvent: true }))).rejects.toThrow("mcp down");

      // One emission, and the phase rejected first: an early phase-5 emit would have come before it.
      expect(order).toEqual(["phase-7.5", "run:completed"]);
    } finally {
      stop();
    }
  });

  test("AC-7: a phase-8 rejection in workflow mode rejects and emits one event with workflowPassed false", async () => {
    const { over, message } = rejectLatePhase("8");
    const { events, stop } = captureCompleted();
    try {
      await expect(handleRunCompletion(opts(WORKFLOW, { deferRunCompletedEvent: true, ...over }))).rejects.toThrow(
        message,
      );

      expect(events).toHaveLength(1);
      expect(events[0]?.workflowPassed).toBe(false);
    } finally {
      stop();
    }
  });

  test("AC-13: either late phase in workflow mode emits workflowPassed false", async () => {
    for (const phase of LATE_PHASES) {
      const { over, message } = rejectLatePhase(phase);
      const { events, stop } = captureCompleted();
      try {
        await expect(handleRunCompletion(opts(WORKFLOW, { deferRunCompletedEvent: true, ...over }))).rejects.toThrow(
          message,
        );

        expect(events).toHaveLength(1);
        expect(events[0]?.workflowPassed).toBe(false);
      } finally {
        stop();
      }
    }
  });

  test("AC-14: either late phase in pipeline mode emits workflowPassed true", async () => {
    for (const phase of LATE_PHASES) {
      const { over, message } = rejectLatePhase(phase);
      const { events, stop } = captureCompleted();
      try {
        await expect(handleRunCompletion(opts(PIPELINE, { deferRunCompletedEvent: true, ...over }))).rejects.toThrow(
          message,
        );

        expect(events).toHaveLength(1);
        expect(events[0]?.workflowPassed).toBe(true);
      } finally {
        stop();
      }
    }
  });

  test("AC-15: the catch drains the bus, so the rejection surfaces only after the subscriber settles", async () => {
    let phaseRejected = false;
    _runCompletionDeps.summarizeMcpAdoptionPhase = mock(async () => {
      phaseRejected = true;
      throw new Error("mcp down");
    }) as typeof _runCompletionDeps.summarizeMcpAdoptionPhase;
    let releaseSubscriber: () => void = () => {};
    const subscriberGate = new Promise<void>((resolve) => {
      releaseSubscriber = resolve;
    });
    let subscriberStarted = false;
    let subscriberSettled = false;
    let emittedAfterPhaseRejection = false;
    let rejected = false;
    const stop = pipelineEventBus.on("run:completed", () => {
      subscriberStarted = true;
      // The catch emitted it: a phase-5 emit would have arrived before the phase rejected.
      emittedAfterPhaseRejection = phaseRejected;
      return subscriberGate.then(() => {
        subscriberSettled = true;
      });
    });

    try {
      const settled = handleRunCompletion(opts(WORKFLOW, { deferRunCompletedEvent: true })).then(
        () => {
          rejected = false;
        },
        () => {
          rejected = true;
        },
      );

      await waitForCondition(() => subscriberStarted);
      // The subscriber is mid-flight: the rejection must not be observable yet.
      expect(rejected).toBe(false);

      releaseSubscriber();
      await settled;

      expect(emittedAfterPhaseRejection).toBe(true);
      expect(rejected).toBe(true);
      expect(subscriberSettled).toBe(true);
    } finally {
      stop();
    }
  });
});
