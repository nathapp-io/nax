/**
 * Integration test: prior-iterations survive PipelineContext recreation (issue #736 Patch B).
 *
 * Scenario: adversarial review fails on round 1, then an autofix session runs and
 * recreates PipelineContext (simulating "cycle exited — agent gave up"). The second
 * call to reviewFromContext must carry the round-1 iteration forward to the adversarial
 * reviewer via priorAdversarialIterations, so the reviewer's prompt will contain the
 * "## Prior Iterations" block with Round 1 finding text (verified by the unit tests for
 * prior-iterations-builder; here we verify the data actually flows end-to-end).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Finding } from "../../../src/findings";
import type { RunAdversarialReviewOptions } from "../../../src/review/adversarial";
import { ReviewOrchestrator, _orchestratorDeps } from "../../../src/review/orchestrator";
import { _reviewAdversarialDeps, _reviewGitDeps as _runnerDeps } from "../../../src/review/runner";
import type { ReviewCheckResult } from "../../../src/review/types";
import { withDepsRestore } from "../../helpers/deps";
import { makeNaxConfig } from "../../helpers/mock-nax-config";
import { makePRD, makeStory } from "../../helpers/mock-story";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { NaxConfig } from "../../../src/config";

// ─── Dep restore ──────────────────────────────────────────────────────────────

withDepsRestore(_runnerDeps, ["getUncommittedFiles"]);
withDepsRestore(_orchestratorDeps, ["spawn"]);
withDepsRestore(_reviewAdversarialDeps, ["runAdversarialReview"]);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORY_ID = "US-RECTIFY";

function makeAdvFinding(msg: string): Finding {
  return {
    source: "adversarial-review",
    severity: "error",
    category: "test-gap",
    message: msg,
    file: "src/handler.ts",
    line: 10,
  };
}

function makeCheckResult(success: boolean, findings: Finding[]): ReviewCheckResult {
  return {
    check: "adversarial",
    success,
    skipped: false,
    command: "adversarial-review",
    exitCode: success ? 0 : 1,
    output: "",
    durationMs: 5,
    findings: success ? [] : findings,
  };
}

function makeCtx(storyId: string): PipelineContext {
  const story = makeStory({ id: storyId, workdir: "" });
  const prd = makePRD({ userStories: [story] });
  const config = makeNaxConfig({
    review: {
      enabled: true,
      checks: ["adversarial"],
      commands: {},
      adversarial: {
        model: "balanced",
        diffMode: "ref",
        rules: [],
        timeoutMs: 60_000,
        excludePatterns: [],
        parallel: false,
        maxConcurrentSessions: 2,
      },
    } as unknown as NaxConfig["review"],
  });
  return {
    config,
    workdir: "/tmp/rectify-test",
    story,
    stories: [story],
    prd,
    plugins: undefined,
    agentManager: undefined,
    runtime: undefined,
  } as unknown as PipelineContext;
}

beforeEach(() => {
  _runnerDeps.getUncommittedFiles = mock(async () => []);
  _orchestratorDeps.spawn = mock(() => ({
    exited: Promise.resolve(0),
    stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); } }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
  })) as unknown as typeof _orchestratorDeps.spawn;
});

afterEach(() => {
  mock.restore();
});

// ─── Integration scenario ─────────────────────────────────────────────────────

describe("prior-iterations survive PipelineContext recreation", () => {
  test("round-2 reviewFromContext receives round-1 findings in priorAdversarialIterations", async () => {
    const round1Finding = makeAdvFinding("AC8 mock never invoked in test");
    const capturedOpts: RunAdversarialReviewOptions[] = [];

    _reviewAdversarialDeps.runAdversarialReview = mock(async (opts: RunAdversarialReviewOptions) => {
      capturedOpts.push(opts);
      return makeCheckResult(false, [round1Finding]);
    });

    const orchestrator = new ReviewOrchestrator();

    // Round 1: adversarial fails → iteration stored in map
    const ctx1 = makeCtx(STORY_ID);
    await orchestrator.reviewFromContext(ctx1);
    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].priorAdversarialIterations).toHaveLength(0);

    // Simulate autofix: "cycle exited — agent gave up" → new PipelineContext (same storyId)
    const ctx2 = makeCtx(STORY_ID);
    await orchestrator.reviewFromContext(ctx2);

    // Round 2 must have received the round-1 iteration from the orchestrator map
    expect(capturedOpts).toHaveLength(2);
    const priorPassedToRound2 = capturedOpts[1].priorAdversarialIterations;
    expect(priorPassedToRound2).toHaveLength(1);
    expect(priorPassedToRound2?.[0].iterationNum).toBe(1);
    expect(priorPassedToRound2?.[0].findingsAfter).toHaveLength(1);
    expect(priorPassedToRound2?.[0].findingsAfter[0].message).toBe("AC8 mock never invoked in test");
  });

  test("round-2 findings are also carried into round-3 after second failure", async () => {
    const f1 = makeAdvFinding("finding round 1");
    const f2 = makeAdvFinding("finding round 2");
    let round = 0;
    const capturedOpts: RunAdversarialReviewOptions[] = [];

    _reviewAdversarialDeps.runAdversarialReview = mock(async (opts: RunAdversarialReviewOptions) => {
      capturedOpts.push(opts);
      round++;
      const findings = round === 1 ? [f1] : [f2];
      return makeCheckResult(false, findings);
    });

    const orchestrator = new ReviewOrchestrator();

    await orchestrator.reviewFromContext(makeCtx(STORY_ID));
    await orchestrator.reviewFromContext(makeCtx(STORY_ID));
    await orchestrator.reviewFromContext(makeCtx(STORY_ID));

    // Round 3 should have 2 prior iterations (rounds 1 and 2)
    const priorRound3 = capturedOpts[2].priorAdversarialIterations;
    expect(priorRound3).toHaveLength(2);
    expect(priorRound3?.[0].iterationNum).toBe(1);
    expect(priorRound3?.[1].iterationNum).toBe(2);
    // Round 2's findingsBefore is round 1's findingsAfter
    expect(priorRound3?.[1].findingsBefore[0].message).toBe("finding round 1");
  });

  test("prior iterations reset to empty after reset() is called between runs", async () => {
    const finding = makeAdvFinding("stale");
    const capturedOpts: RunAdversarialReviewOptions[] = [];

    _reviewAdversarialDeps.runAdversarialReview = mock(async (opts: RunAdversarialReviewOptions) => {
      capturedOpts.push(opts);
      return makeCheckResult(false, [finding]);
    });

    const orchestrator = new ReviewOrchestrator();

    // Run 1
    await orchestrator.reviewFromContext(makeCtx(STORY_ID));
    orchestrator.reset();

    // Run 2 — after reset, second reviewFromContext should see no prior iterations
    await orchestrator.reviewFromContext(makeCtx(STORY_ID));

    expect(capturedOpts[1].priorAdversarialIterations).toHaveLength(0);
  });
});
