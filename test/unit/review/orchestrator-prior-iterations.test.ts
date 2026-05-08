/**
 * Unit tests for ReviewOrchestrator — prior-iterations map lifecycle (issue #736 Patch B).
 *
 * Covers:
 * - Adversarial fail: iteration appended to per-story map
 * - Adversarial second fail: second iteration appended with correct findingsBefore
 * - Adversarial pass: map entry deleted
 * - Semantic fail/pass: mirrors adversarial behavior
 * - PipelineContext recreation: map survives (ctx is not the source of truth)
 * - clearStory: removes only the named story
 * - reset: removes all stories
 * - Cross-run isolation: reset() + new story starts fresh
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import type { Finding, Iteration } from "../../../src/findings";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD } from "../../../src/prd/types";
import { ReviewOrchestrator, _orchestratorDeps } from "../../../src/review/orchestrator";
import { _reviewAdversarialDeps, _reviewGitDeps as _runnerDeps, _reviewSemanticDeps } from "../../../src/review/runner";
import type { ReviewCheckResult } from "../../../src/review/types";
import { withDepsRestore } from "../../helpers/deps";
import { makeNaxConfig } from "../../helpers/mock-nax-config";
import { makePRD, makeStory } from "../../helpers/mock-story";

// ─── Dep restore ──────────────────────────────────────────────────────────────

withDepsRestore(_runnerDeps, ["getUncommittedFiles"]);
withDepsRestore(_orchestratorDeps, ["spawn"]);
withDepsRestore(_reviewAdversarialDeps, ["runAdversarialReview"]);
withDepsRestore(_reviewSemanticDeps, ["runSemanticReview"]);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORY_ID = "US-042";

function makeAdversarialFinding(msg: string): Finding {
  return {
    source: "adversarial-review",
    severity: "error",
    category: "test-gap",
    message: msg,
    file: "src/foo.ts",
    line: 1,
  };
}

function makeAdvCheckResult(success: boolean, findings: Finding[] = []): ReviewCheckResult {
  return {
    check: "adversarial",
    success,
    skipped: false,
    command: "adversarial-review",
    exitCode: success ? 0 : 1,
    output: "",
    durationMs: 10,
    findings: success ? [] : findings,
  };
}

function makeSemCheckResult(success: boolean, findings: Finding[] = []): ReviewCheckResult {
  return {
    check: "semantic",
    success,
    skipped: false,
    command: "semantic-review",
    exitCode: success ? 0 : 1,
    output: "",
    durationMs: 10,
    findings: success ? [] : findings,
  };
}

function makeAdvConfig(): NaxConfig["review"] {
  return {
    enabled: true,
    checks: ["adversarial"] as NaxConfig["review"]["checks"],
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
  } as unknown as NaxConfig["review"];
}

function makeSemConfig(): NaxConfig["review"] {
  return {
    enabled: true,
    checks: ["semantic"] as NaxConfig["review"]["checks"],
    commands: {},
  } as unknown as NaxConfig["review"];
}

function makeMinimalCtx(storyId: string, reviewConfig: NaxConfig["review"]): PipelineContext {
  const story = makeStory({ id: storyId, workdir: "" });
  const prd: PRD = makePRD({ userStories: [story] });
  const config = makeNaxConfig({ review: reviewConfig as NaxConfig["review"] });
  return {
    config,
    workdir: "/tmp/test",
    story,
    stories: [story],
    prd,
    plugins: undefined,
    agentManager: undefined,
    runtime: undefined,
  } as unknown as PipelineContext;
}

beforeEach(() => {
  // Mechanical check: no dirty files → reviewer proceeds
  _runnerDeps.getUncommittedFiles = mock(async () => []);
  // Git spawn: empty diff output
  _orchestratorDeps.spawn = mock(() => ({
    exited: Promise.resolve(0),
    stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); } }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
  })) as unknown as typeof _orchestratorDeps.spawn;
});

afterEach(() => {
  mock.restore();
});

// ─── clearStory / reset — pure map operations ─────────────────────────────────

describe("ReviewOrchestrator — clearStory / reset", () => {
  test("clearStory removes only the named story", () => {
    const orchestrator = new ReviewOrchestrator();
    const maps = orchestrator as unknown as {
      priorAdversarialByStory: Map<string, Iteration[]>;
      priorSemanticByStory: Map<string, Iteration[]>;
    };

    const iter: Iteration = {
      iterationNum: 1,
      findingsBefore: [],
      fixesApplied: [],
      findingsAfter: [makeAdversarialFinding("x")],
      outcome: "unchanged",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    };
    maps.priorAdversarialByStory.set("US-001", [iter]);
    maps.priorAdversarialByStory.set("US-002", [iter]);

    orchestrator.clearStory("US-001");

    expect(maps.priorAdversarialByStory.has("US-001")).toBe(false);
    expect(maps.priorAdversarialByStory.has("US-002")).toBe(true);
  });

  test("clearStory removes both adversarial and semantic maps for the story", () => {
    const orchestrator = new ReviewOrchestrator();
    const maps = orchestrator as unknown as {
      priorAdversarialByStory: Map<string, Iteration[]>;
      priorSemanticByStory: Map<string, Iteration[]>;
    };

    const iter: Iteration = {
      iterationNum: 1, findingsBefore: [], fixesApplied: [],
      findingsAfter: [], outcome: "resolved",
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
    };
    maps.priorAdversarialByStory.set("US-001", [iter]);
    maps.priorSemanticByStory.set("US-001", [iter]);

    orchestrator.clearStory("US-001");

    expect(maps.priorAdversarialByStory.has("US-001")).toBe(false);
    expect(maps.priorSemanticByStory.has("US-001")).toBe(false);
  });

  test("clearStory on absent storyId is a no-op", () => {
    const orchestrator = new ReviewOrchestrator();
    expect(() => orchestrator.clearStory("does-not-exist")).not.toThrow();
  });

  test("reset clears all stories from both maps", () => {
    const orchestrator = new ReviewOrchestrator();
    const maps = orchestrator as unknown as {
      priorAdversarialByStory: Map<string, Iteration[]>;
      priorSemanticByStory: Map<string, Iteration[]>;
    };

    const iter: Iteration = {
      iterationNum: 1, findingsBefore: [], fixesApplied: [],
      findingsAfter: [], outcome: "resolved",
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
    };
    maps.priorAdversarialByStory.set("US-001", [iter]);
    maps.priorAdversarialByStory.set("US-002", [iter]);
    maps.priorSemanticByStory.set("US-001", [iter]);

    orchestrator.reset();

    expect(maps.priorAdversarialByStory.size).toBe(0);
    expect(maps.priorSemanticByStory.size).toBe(0);
  });
});

// ─── Map write: adversarial fail / pass ──────────────────────────────────────

describe("ReviewOrchestrator — adversarial map write via reviewFromContext", () => {
  test("appends iteration to map on first adversarial failure", async () => {
    const finding = makeAdversarialFinding("missing null check");
    _reviewAdversarialDeps.runAdversarialReview = mock(async () => makeAdvCheckResult(false, [finding]));

    const orchestrator = new ReviewOrchestrator();
    const ctx = makeMinimalCtx(STORY_ID, makeAdvConfig());

    await orchestrator.reviewFromContext(ctx);

    const maps = orchestrator as unknown as { priorAdversarialByStory: Map<string, Iteration[]> };
    const iterations = maps.priorAdversarialByStory.get(STORY_ID);
    expect(iterations).toBeDefined();
    expect(iterations?.length).toBe(1);
    expect(iterations?.[0].iterationNum).toBe(1);
    expect(iterations?.[0].findingsAfter).toHaveLength(1);
    expect(iterations?.[0].findingsAfter[0].message).toBe("missing null check");
  });

  test("appends second iteration with findingsBefore from first round", async () => {
    const f1 = makeAdversarialFinding("first finding");
    const f2 = makeAdversarialFinding("second finding");
    let callCount = 0;
    _reviewAdversarialDeps.runAdversarialReview = mock(async () => {
      callCount++;
      return makeAdvCheckResult(false, callCount === 1 ? [f1] : [f2]);
    });

    const orchestrator = new ReviewOrchestrator();
    const ctx1 = makeMinimalCtx(STORY_ID, makeAdvConfig());
    const ctx2 = makeMinimalCtx(STORY_ID, makeAdvConfig());

    await orchestrator.reviewFromContext(ctx1);
    await orchestrator.reviewFromContext(ctx2);

    const maps = orchestrator as unknown as { priorAdversarialByStory: Map<string, Iteration[]> };
    const iterations = maps.priorAdversarialByStory.get(STORY_ID);
    expect(iterations?.length).toBe(2);
    expect(iterations?.[1].iterationNum).toBe(2);
    expect(iterations?.[1].findingsBefore).toHaveLength(1);
    expect(iterations?.[1].findingsBefore[0].message).toBe("first finding");
    expect(iterations?.[1].findingsAfter[0].message).toBe("second finding");
  });

  test("deletes map entry when adversarial passes", async () => {
    const finding = makeAdversarialFinding("x");
    let passNext = false;
    _reviewAdversarialDeps.runAdversarialReview = mock(async () =>
      makeAdvCheckResult(passNext, passNext ? [] : [finding]),
    );

    const orchestrator = new ReviewOrchestrator();
    const ctx1 = makeMinimalCtx(STORY_ID, makeAdvConfig());
    await orchestrator.reviewFromContext(ctx1);

    const maps = orchestrator as unknown as { priorAdversarialByStory: Map<string, Iteration[]> };
    expect(maps.priorAdversarialByStory.has(STORY_ID)).toBe(true);

    passNext = true;
    const ctx2 = makeMinimalCtx(STORY_ID, makeAdvConfig());
    await orchestrator.reviewFromContext(ctx2);

    expect(maps.priorAdversarialByStory.has(STORY_ID)).toBe(false);
  });

  test("survives PipelineContext recreation — map entry from ctx_v1 is present for ctx_v2", async () => {
    const finding = makeAdversarialFinding("stale finding");
    const capturedPriorIterations: (Iteration[] | undefined)[] = [];
    _reviewAdversarialDeps.runAdversarialReview = mock(async (opts) => {
      capturedPriorIterations.push(opts.priorAdversarialIterations);
      return makeAdvCheckResult(false, [finding]);
    });

    const orchestrator = new ReviewOrchestrator();
    const ctx1 = makeMinimalCtx(STORY_ID, makeAdvConfig());
    await orchestrator.reviewFromContext(ctx1);

    // Simulate "agent gave up" → fresh PipelineContext created with same story
    const ctx2 = makeMinimalCtx(STORY_ID, makeAdvConfig());
    // ctx2 has NO priorAdversarialIterations (it's a fresh ctx, and the field no longer exists)
    await orchestrator.reviewFromContext(ctx2);

    // Second call should have received the first round's iterations from the map
    expect(capturedPriorIterations[1]).toHaveLength(1);
    expect(capturedPriorIterations[1]?.[0].iterationNum).toBe(1);
  });
});

// ─── Map write: semantic mirroring ───────────────────────────────────────────

describe("ReviewOrchestrator — semantic map mirrors adversarial behavior", () => {
  test("appends semantic iteration on failure", async () => {
    const finding: Finding = {
      source: "semantic-review", severity: "error",
      category: "ac-coverage", message: "AC not tested",
    };
    _reviewSemanticDeps.runSemanticReview = mock(async () => makeSemCheckResult(false, [finding]));

    const orchestrator = new ReviewOrchestrator();
    const ctx = makeMinimalCtx(STORY_ID, makeSemConfig());

    await orchestrator.reviewFromContext(ctx);

    const maps = orchestrator as unknown as { priorSemanticByStory: Map<string, Iteration[]> };
    const iterations = maps.priorSemanticByStory.get(STORY_ID);
    expect(iterations?.length).toBe(1);
    expect(iterations?.[0].findingsAfter[0].message).toBe("AC not tested");
  });

  test("deletes semantic map entry when semantic passes", async () => {
    const finding: Finding = {
      source: "semantic-review", severity: "error",
      category: "ac-coverage", message: "AC not tested",
    };
    let passNext = false;
    _reviewSemanticDeps.runSemanticReview = mock(async () =>
      makeSemCheckResult(passNext, passNext ? [] : [finding]),
    );

    const orchestrator = new ReviewOrchestrator();
    const ctx1 = makeMinimalCtx(STORY_ID, makeSemConfig());
    await orchestrator.reviewFromContext(ctx1);

    const maps = orchestrator as unknown as { priorSemanticByStory: Map<string, Iteration[]> };
    expect(maps.priorSemanticByStory.has(STORY_ID)).toBe(true);

    passNext = true;
    const ctx2 = makeMinimalCtx(STORY_ID, makeSemConfig());
    await orchestrator.reviewFromContext(ctx2);

    expect(maps.priorSemanticByStory.has(STORY_ID)).toBe(false);
  });
});

// ─── Cross-run isolation ──────────────────────────────────────────────────────

describe("ReviewOrchestrator — cross-run isolation via reset()", () => {
  test("does not leak iterations across runs", async () => {
    const finding = makeAdversarialFinding("from run 1");
    const capturedPrior: (Iteration[] | undefined)[] = [];
    _reviewAdversarialDeps.runAdversarialReview = mock(async (opts) => {
      capturedPrior.push(opts.priorAdversarialIterations);
      return makeAdvCheckResult(false, [finding]);
    });

    const orchestrator = new ReviewOrchestrator();

    // Run 1: adversarial fails, map gets an entry
    const ctx1 = makeMinimalCtx(STORY_ID, makeAdvConfig());
    await orchestrator.reviewFromContext(ctx1);

    // End of run 1: reset
    orchestrator.reset();

    // Run 2: fresh start, same storyId — should see no prior iterations
    const ctx2 = makeMinimalCtx(STORY_ID, makeAdvConfig());
    await orchestrator.reviewFromContext(ctx2);

    expect(capturedPrior[1]).toHaveLength(0);
  });
});
