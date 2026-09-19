/**
 * Tests for AC12–AC14 of US-002: post-run story-completion path persists the
 * next-story roll-forward baseline (or a `no-gate-parse` marker when the
 * gate phase did not produce a summary, and skips entirely in parallel mode).
 *
 * The post-run calls `invokeRollForwardFromContext` from
 * `src/execution/lifecycle/test-baseline-capture.ts`, which delegates to
 * `persistNextStoryRollForward`. The delegation stub writes a single
 * `no-baseline` marker — these tests assert on the SHAPE the implementer
 * must produce, so every AC except AC14 fails its assertion until the
 * implementer wires the right branch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makePRD, makeStory, makeTestContext } from "@test/helpers";
import type { AgentResult } from "@/agents/types";
import type { CaptureParsedSummary } from "@/execution/lifecycle/test-baseline-capture";
import { _captureDeps } from "@/execution/lifecycle/test-baseline-capture";
import type { PostRunInspectionResult } from "@/execution/post-run";
import { decideStageAction } from "@/execution/post-run";
import type { StoryOrchestratorResult } from "@/execution/story-orchestrator";
import { fullSuiteGateOp } from "@/operations";

const origWriteStoryBaseline = _captureDeps.writeStoryBaseline;

function makeGateSummary(): CaptureParsedSummary {
  return {
    passed: 0,
    failed: 2,
    failures: [
      { file: "test/unit/foo.test.ts", testName: "should pass" },
      { file: "test/unit/bar.test.ts", testName: "should also pass" },
    ],
  };
}

function makeGatePhaseOutput(summary: CaptureParsedSummary | undefined): Record<string, unknown> {
  return {
    [fullSuiteGateOp.name]: summary
      ? { success: false, passed: false, findings: [], parsedSummary: summary }
      : undefined,
  };
}

function makePlanResult(
  phaseOutputs: Record<string, unknown> = makeGatePhaseOutput(makeGateSummary()),
): StoryOrchestratorResult {
  return {
    success: true,
    phaseCosts: {},
    totalCostUsd: 0,
    durationMs: 100,
    phaseOutputs,
  };
}

function makeInspectionOpts(): Parameters<typeof decideStageAction>[3] {
  return {
    capturedTokenUsage: undefined,
    capturedResponse: "",
    capturedCostUsd: 0,
    tddMode: null,
    initialRef: "abc",
    untrackedBefore: null,
  };
}

/** Minimal but type-correct PostRunInspectionResult — only the fields post-run reads. */
function makeInspection(): PostRunInspectionResult {
  const agentResult: AgentResult = {
    success: true,
    exitCode: 0,
    output: "",
    rateLimited: false,
    durationMs: 100,
    estimatedCostUsd: 0,
  };
  return {
    agentResult,
    selfVerificationFailed: false,
    needsHumanReview: false,
    providerUnavailable: false,
    combinedOutput: "",
  };
}

/** Override ctx.prd to carry two stories and pin ctx.story to the first. */
function setTwoStoryPrd(ctx: ReturnType<typeof makeTestContext>): void {
  ctx.prd = makePRD({
    userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })],
  });
  ctx.story = makeStory({ id: "US-001" });
}

afterEach(() => {
  _captureDeps.writeStoryBaseline = origWriteStoryBaseline;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12 — sequential completion + parsed summary → invokes roll-forward writer
//         with summary.failures + source roll-forward
// ─────────────────────────────────────────────────────────────────────────────

describe("post-run — AC12 (sequential roll-forward write)", () => {
  test("AC12: when story completes sequentially with a parsed summary, the roll-forward writer is invoked for the next story id with the summary's failures and source=roll-forward", async () => {
    const writes: Array<{ storyId: string; baseline: unknown }> = [];
    _captureDeps.writeStoryBaseline = async (_root: string, _featureId: string, storyId: string, baseline: unknown) => {
      writes.push({ storyId, baseline });
    };

    const ctx = makeTestContext();
    setTwoStoryPrd(ctx);

    await decideStageAction(ctx, makePlanResult(), makeInspection(), makeInspectionOpts());

    // The write is invoked exactly once, for the NEXT story (US-002).
    expect(writes).toHaveLength(1);
    expect(writes[0]?.storyId).toBe("US-002");
    const baseline = writes[0]?.baseline as
      | { kind?: string; source?: string; entries?: { file: string; testName?: string }[] }
      | undefined;
    expect(baseline?.kind).toBe("captured");
    expect(baseline?.source).toBe("roll-forward");
    expect(baseline?.entries).toEqual([
      { file: "test/unit/foo.test.ts", testName: "should pass" },
      { file: "test/unit/bar.test.ts", testName: "should also pass" },
    ]);
  });

  test("AC12 boundary: every parsed failure becomes an entry carrying its file and testName", async () => {
    const writes: Array<{ storyId: string; baseline: unknown }> = [];
    _captureDeps.writeStoryBaseline = async (_root: string, _featureId: string, storyId: string, baseline: unknown) => {
      writes.push({ storyId, baseline });
    };

    const summary: CaptureParsedSummary = {
      passed: 0,
      failed: 3,
      failures: [
        { file: "a.test.ts", testName: "test A" },
        { file: "b.test.ts", testName: "test B" },
        { file: "c.test.ts", testName: "test C" },
      ],
    };

    const ctx = makeTestContext();
    setTwoStoryPrd(ctx);

    await decideStageAction(ctx, makePlanResult(makeGatePhaseOutput(summary)), makeInspection(), makeInspectionOpts());

    expect(writes).toHaveLength(1);
    const baseline = writes[0]?.baseline as { entries?: { file: string; testName?: string }[] } | undefined;
    expect(baseline?.entries?.map((e) => e.file)).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
    expect(baseline?.entries?.map((e) => e.testName)).toEqual(["test A", "test B", "test C"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13 — sequential + no usable gate parse → no-gate-parse marker
// ─────────────────────────────────────────────────────────────────────────────

describe("post-run — AC13 (no-gate-parse marker)", () => {
  test("AC13: when the gate phase did not produce a parsed summary, the next-story baseline is a no-baseline marker with reason no-gate-parse", async () => {
    const writes: Array<{ storyId: string; baseline: { kind?: string; reason?: string } }> = [];
    _captureDeps.writeStoryBaseline = async (_root: string, _featureId: string, storyId: string, baseline: unknown) => {
      writes.push({ storyId, baseline: baseline as { kind?: string; reason?: string } });
    };

    const ctx = makeTestContext();
    setTwoStoryPrd(ctx);

    // phaseOutputs has no full-suite-gate key → no usable gate parse.
    await decideStageAction(ctx, makePlanResult({}), makeInspection(), makeInspectionOpts());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.storyId).toBe("US-002");
    expect(writes[0]?.baseline.kind).toBe("no-baseline");
    expect(writes[0]?.baseline.reason).toBe("no-gate-parse");
  });

  test("AC13 boundary: a gate phase output without parsedSummary also resolves to no-gate-parse", async () => {
    const writes: Array<{ storyId: string; baseline: { kind?: string; reason?: string } }> = [];
    _captureDeps.writeStoryBaseline = async (_root: string, _featureId: string, storyId: string, baseline: unknown) => {
      writes.push({ storyId, baseline: baseline as { kind?: string; reason?: string } });
    };

    const ctx = makeTestContext();
    setTwoStoryPrd(ctx);

    // Gate ran but produced no parsedSummary — only success/passed/findings.
    await decideStageAction(
      ctx,
      makePlanResult({ [fullSuiteGateOp.name]: { success: true, passed: true, findings: [] } }),
      makeInspection(),
      makeInspectionOpts(),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.baseline.kind).toBe("no-baseline");
    expect(writes[0]?.baseline.reason).toBe("no-gate-parse");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC14 — parallel mode → roll-forward writer NOT invoked
// ─────────────────────────────────────────────────────────────────────────────

describe("post-run — AC14 (parallel mode skips roll-forward)", () => {
  test("AC14: when the story ran under a parallel batch orchestrator, the roll-forward writer is not invoked", async () => {
    const writes: string[] = [];
    _captureDeps.writeStoryBaseline = async () => {
      writes.push("called");
    };

    const ctx = makeTestContext({ skipPrdPersistence: true }); // parallel-mode marker set by parallel-batch.ts
    setTwoStoryPrd(ctx);

    await decideStageAction(
      ctx,
      makePlanResult(makeGatePhaseOutput(makeGateSummary())),
      makeInspection(),
      makeInspectionOpts(),
    );

    expect(writes).toHaveLength(0);
  });

  test("AC14 boundary: even a failing gate in parallel mode does not invoke the roll-forward writer", async () => {
    const writes: string[] = [];
    _captureDeps.writeStoryBaseline = async () => {
      writes.push("called");
    };

    const ctx = makeTestContext({ skipPrdPersistence: true });
    setTwoStoryPrd(ctx);

    await decideStageAction(ctx, makePlanResult({}), makeInspection(), makeInspectionOpts());

    expect(writes).toHaveLength(0);
  });
});
