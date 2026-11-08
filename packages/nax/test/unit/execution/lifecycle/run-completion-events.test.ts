/**
 * Tests for postrun phase event details in handleRunCompletion (US-004)
 *
 * AC8: deferred review completed event details.findingCount equals produced finding count
 * AC9: any postrun phase completed event durationMs equals elapsed from matching started event
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { RunCompletionOptions } from "@/execution";
import { handleRunCompletion } from "@/execution";
import type { DeferredReviewResult } from "@/execution/deferred-review";
import type { PostRunPhaseCompletedEvent, PostRunPhaseStartedEvent } from "@/pipeline";
import { pipelineEventBus } from "@/pipeline";
import type { PRD, UserStory } from "@/prd";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePRD(storyIds: string[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: storyIds.map((id) =>
      makeStory({ id, title: `Story ${id}`, description: "Test story", status: "passed", passes: true, attempts: 1 }),
    ) as UserStory[],
  };
}

const WORKDIR = `/tmp/nax-test-run-completion-events-${randomUUID()}`;

function makeOpts(config: NaxConfig, prd: PRD, overrides?: Partial<RunCompletionOptions>): RunCompletionOptions {
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    startTime: Date.now() - 50,
    workdir: WORKDIR,
    statusWriter: makeStatusWriter(),
    config,
    runtime: makeMockRuntime(),
    agentManager: makeMockAgentManager(),
    sessionManager: makeSessionManager(),
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  pipelineEventBus.clear();
});

afterEach(() => {
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC8: deferred review completed event details.findingCount equals produced finding count
// ---------------------------------------------------------------------------

describe("handleRunCompletion — AC8: review completed event details.findingCount", () => {
  test("AC8: details.findingCount equals number of failed reviewers when review has failures", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      completed.push(e);
    });

    const deferredReview: DeferredReviewResult = {
      runStartRef: "abc123",
      changedFiles: ["src/foo.ts"],
      anyFailed: true,
      reviewerResults: [
        { name: "reviewer-a", passed: false, output: "finding 1" },
        { name: "reviewer-b", passed: false, output: "finding 2" },
        { name: "reviewer-c", passed: true, output: "" },
      ],
    };

    const prd = makePRD(["US-001"]);
    const config = makeNaxConfig({
      review: { pluginMode: "observational" },
    });

    await handleRunCompletion(makeOpts(config, prd, { deferredReview }));

    const event = completed.find((e) => e.phase === "review");
    expect(event).toBeDefined();
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.findingCount).toBe(2);
  });

  test("AC8: details.findingCount is 0 when all reviewers pass", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      completed.push(e);
    });

    const deferredReview: DeferredReviewResult = {
      runStartRef: "abc123",
      changedFiles: [],
      anyFailed: false,
      reviewerResults: [
        { name: "reviewer-a", passed: true, output: "" },
        { name: "reviewer-b", passed: true, output: "" },
      ],
    };

    const prd = makePRD(["US-001"]);
    const config = makeNaxConfig({
      review: { pluginMode: "observational" },
    });

    await handleRunCompletion(makeOpts(config, prd, { deferredReview }));

    const event = completed.find((e) => e.phase === "review");
    expect(event).toBeDefined();
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.findingCount).toBe(0);
  });

  test("AC8 boundary: details.anyFailed mirrors deferredReview.anyFailed", async () => {
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      completed.push(e);
    });

    const deferredReview: DeferredReviewResult = {
      runStartRef: "abc123",
      changedFiles: [],
      anyFailed: true,
      reviewerResults: [{ name: "reviewer-a", passed: false, output: "bad" }],
    };

    const prd = makePRD(["US-001"]);
    const config = makeNaxConfig({
      review: { pluginMode: "observational" },
    });

    await handleRunCompletion(makeOpts(config, prd, { deferredReview }));

    const event = completed.find((e) => e.phase === "review");
    const details = event?.details as Record<string, unknown> | undefined;
    expect(details?.anyFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC9: postrun phase completed durationMs equals elapsed from matching started event
// ---------------------------------------------------------------------------

describe("handleRunCompletion — AC9: durationMs in completed events", () => {
  test("AC9: review durationMs reflects elapsed from postrun:phase:started, not from inside the completion call", async () => {
    // postrun:phase:started for review fires in unified-executor.ts BEFORE the review runs.
    // handleRunCompletion only receives the already-completed deferredReview result.
    // durationMs must reflect elapsed time from that started event — NOT the trivial
    // overhead of Date.now()-Date.now() measured inside handleRunCompletion itself.
    //
    // The implementer threads deferredReviewStartedAt through RunCompletionOptions so
    // handleRunCompletion can compute durationMs = Date.now() - deferredReviewStartedAt.
    const started: PostRunPhaseStartedEvent[] = [];
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:started", (e) => {
      started.push(e);
    });
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      completed.push(e);
    });

    const deferredReview: DeferredReviewResult = {
      runStartRef: "ref",
      changedFiles: [],
      anyFailed: false,
      reviewerResults: [{ name: "r", passed: true, output: "" }],
    };

    const prd = makePRD(["US-001"]);
    const config = makeNaxConfig({
      review: { pluginMode: "observational" },
    });

    // Simulate: postrun:phase:started (review) was emitted 200ms before this call.
    // The implementer stores this as deferredReviewStartedAt on RunCompletionOptions.
    const deferredReviewStartedAt = Date.now() - 200;
    await handleRunCompletion(
      makeOpts(config, prd, {
        deferredReview,
        deferredReviewStartedAt,
      } as Partial<RunCompletionOptions>),
    );

    // handleRunCompletion must NOT emit postrun:phase:started for review —
    // that event already fired in unified-executor.ts before the review ran.
    expect(started.find((e) => e.phase === "review")).toBeUndefined();

    const reviewCompleted = completed.find((e) => e.phase === "review");
    expect(reviewCompleted).toBeDefined();
    expect(typeof reviewCompleted?.durationMs).toBe("number");
    // Wrong impl: durationMs ≈ 0 (Date.now()-Date.now() inside handleRunCompletion)
    // Correct impl: durationMs ≈ 200 (Date.now() - deferredReviewStartedAt)
    expect(reviewCompleted?.durationMs).toBeGreaterThanOrEqual(150);
  });
});
