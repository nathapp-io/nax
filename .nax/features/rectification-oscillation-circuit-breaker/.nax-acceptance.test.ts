import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AdversarialReviewConfigSchema } from "../../../src/config/schemas-review";
import { DEFAULT_CONFIG } from "../../../src/config";
import { createRuntime, type NaxRuntime } from "../../../src/runtime";
import { getOscillations, recordOscillations } from "../../../src/execution/oscillation-store";
import { _postRunDeps, applyPostRunInspection, decideStageAction } from "../../../src/execution";
import { makeTestContext, makeTestStory } from "../../../test/helpers";
import {
  makeInspectionOpts,
  makePlanResult,
  TEST_RUNNER_FINDING,
} from "../../../test/unit/execution/_post-run-fixtures";

// ─── Local test helpers ───────────────────────────────────────────────────────

/**
 * Parse adversarial review config from an input shape that mirrors the nax
 * config's `review` key — used by AC-9 through AC-11.
 */
function parseReviewConfig(input: { review?: Record<string, unknown> } = {}) {
  return AdversarialReviewConfigSchema.parse(input.review ?? {});
}

/** Count iterations whose outcome is "regressed-different-source" (AC-12, AC-13). */
function countRegressedDifferentSource(iterations: Array<{ outcome: string }>): number {
  return iterations.filter((i) => i.outcome === "regressed-different-source").length;
}

/** Minimal runtime stub that exposes only the oscillation store. */
function makeRuntimeWithOscillations(oscillations: Map<string, number>): NaxRuntime {
  return { rectificationOscillations: oscillations } as unknown as NaxRuntime;
}

/** Build a PipelineContext wired for circuit-breaker tests. */
function makeCircuitBreakerCtx({
  storyId = "story-1",
  oscillationCount,
  enabled = true,
  maxOscillations = 2,
  omitRuntime = false,
  interaction,
}: {
  storyId?: string;
  oscillationCount?: number;
  enabled?: boolean;
  maxOscillations?: number;
  omitRuntime?: boolean;
  interaction?: unknown;
} = {}) {
  const oscillations = new Map<string, number>();
  if (oscillationCount !== undefined) {
    oscillations.set(storyId, oscillationCount);
  }

  const runtime = omitRuntime
    ? undefined
    : makeRuntimeWithOscillations(oscillations);

  const story = makeTestStory({ id: storyId });

  return makeTestContext({
    story,
    runtime: runtime as unknown as NaxRuntime,
    config: {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        adversarial: {
          ...(DEFAULT_CONFIG.review.adversarial ?? AdversarialReviewConfigSchema.parse({})),
          conflictDetection: { enabled, maxOscillations },
        },
      },
    },
    ...(interaction !== undefined ? { interaction } : {}),
  } as Parameters<typeof makeTestContext>[0]);
}

// ─── US-001: Oscillation store primitives ─────────────────────────────────────

describe("AC-1: recordOscillations and getOscillations are callable functions", () => {
  test("AC-1: typeof recordOscillations === 'function' && typeof getOscillations === 'function'", () => {
    expect(typeof recordOscillations).toBe("function");
    expect(typeof getOscillations).toBe("function");
  });
});

describe("AC-2: getOscillations on a fresh Map returns 0", () => {
  test("AC-2: getOscillations(new Map(), 'US-9') === 0", () => {
    expect(getOscillations(new Map(), "US-9")).toBe(0);
  });
});

describe("AC-3: recordOscillations returns the new cumulative total", () => {
  test("AC-3: recordOscillations(store, 'US-1', 2) returns 2", () => {
    const store = new Map<string, number>();
    const result = recordOscillations(store, "US-1", 2);
    expect(result).toBe(2);
  });
});

describe("AC-4: getOscillations reflects the recorded count", () => {
  test("AC-4: after recordOscillations(store, 'US-1', 2), getOscillations returns 2", () => {
    const store = new Map<string, number>();
    recordOscillations(store, "US-1", 2);
    expect(getOscillations(store, "US-1")).toBe(2);
  });
});

describe("AC-5: recordOscillations accumulates across calls", () => {
  test("AC-5: delta 1 then delta 2 → second call returns 3", () => {
    const store = new Map<string, number>();
    recordOscillations(store, "US-1", 1);
    const result = recordOscillations(store, "US-1", 2);
    expect(result).toBe(3);
  });
});

describe("AC-6 and AC-7: per-story isolation", () => {
  test("AC-6: story A accumulates to 3 independently of story B", () => {
    const store = new Map<string, number>();
    recordOscillations(store, "A", 2);
    recordOscillations(store, "B", 5);
    recordOscillations(store, "A", 1);
    expect(getOscillations(store, "A")).toBe(3);
  });

  test("AC-7: story B retains 5 despite story A's additional increment", () => {
    const store = new Map<string, number>();
    recordOscillations(store, "A", 2);
    recordOscillations(store, "B", 5);
    recordOscillations(store, "A", 1);
    expect(getOscillations(store, "B")).toBe(5);
  });
});

// ─── US-001: Runtime initialization ──────────────────────────────────────────

describe("AC-8: createRuntime initializes rectificationOscillations", () => {
  const createdRuntimes: NaxRuntime[] = [];

  afterEach(async () => {
    await Promise.allSettled(createdRuntimes.map((rt) => rt.close()));
    createdRuntimes.length = 0;
  });

  test("AC-8: rectificationOscillations is a Map with size 0 on a fresh runtime", () => {
    const rt = createRuntime(DEFAULT_CONFIG, "/tmp/test");
    createdRuntimes.push(rt);
    expect(rt.rectificationOscillations).toBeInstanceOf(Map);
    expect(rt.rectificationOscillations.size).toBe(0);
  });
});

// ─── US-001: Config schema defaults ──────────────────────────────────────────

describe("AC-9 to AC-11: conflictDetection schema defaults and overrides", () => {
  test("AC-9: empty config → conflictDetection.enabled defaults to true", () => {
    const config = parseReviewConfig({});
    expect(config.conflictDetection.enabled).toBe(true);
  });

  test("AC-10: empty config → conflictDetection.maxOscillations defaults to 2", () => {
    const config = parseReviewConfig({});
    expect(config.conflictDetection.maxOscillations).toBe(2);
  });

  test("AC-11: setting maxOscillations to 4 is reflected in parsed config", () => {
    const config = parseReviewConfig({ review: { conflictDetection: { maxOscillations: 4 } } });
    expect(config.conflictDetection.maxOscillations).toBe(4);
  });
});

// ─── US-002: Outcome-count helper ────────────────────────────────────────────

describe("AC-12 and AC-13: countRegressedDifferentSource", () => {
  test("AC-12: 2 of 3 iterations are regressed-different-source → returns 2", () => {
    const iterations = [
      { outcome: "regressed-different-source" },
      { outcome: "partial" },
      { outcome: "regressed-different-source" },
    ];
    expect(countRegressedDifferentSource(iterations)).toBe(2);
  });

  test("AC-13: no regressed-different-source iterations → returns 0", () => {
    const iterations = [
      { outcome: "fixed" },
      { outcome: "partial" },
      { outcome: "regressed-same-source" },
    ];
    expect(countRegressedDifferentSource(iterations)).toBe(0);
  });
});

// ─── US-002: PipelineContext store round-trip ─────────────────────────────────

describe("AC-14: oscillation store round-trip via ctx.runtime.rectificationOscillations", () => {
  test("AC-14: recordOscillations then getOscillations returns 1 for story-1", () => {
    const oscillations = new Map<string, number>();
    const rt = makeRuntimeWithOscillations(oscillations);
    const story = makeTestStory({ id: "story-1" });
    const ctx = makeTestContext({
      story,
      runtime: rt as unknown as NaxRuntime,
    } as Parameters<typeof makeTestContext>[0]);

    recordOscillations(ctx.runtime.rectificationOscillations, ctx.story.id, 1);
    expect(getOscillations(ctx.runtime.rectificationOscillations, ctx.story.id)).toBe(1);
  });
});

// ─── US-002: decideStageAction circuit-breaker ────────────────────────────────

describe("decideStageAction oscillation circuit-breaker", () => {
  let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
  let origDetect: typeof _postRunDeps.detectMergeConflict;
  let origFailClose: typeof _postRunDeps.failAndClose;

  beforeEach(() => {
    origAutoCommit = _postRunDeps.autoCommitIfDirty;
    origDetect = _postRunDeps.detectMergeConflict;
    origFailClose = _postRunDeps.failAndClose;
    _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;
    _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
    _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
  });

  afterEach(() => {
    _postRunDeps.autoCommitIfDirty = origAutoCommit;
    _postRunDeps.detectMergeConflict = origDetect;
    _postRunDeps.failAndClose = origFailClose;
  });

  test("AC-15: count >= maxOscillations + enabled → decideStageAction returns pause", async () => {
    const ctx = makeCircuitBreakerCtx({ oscillationCount: 2, enabled: true, maxOscillations: 2 });
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("pause");
  });

  test("AC-16: pause reason contains the threshold count '2'", async () => {
    const ctx = makeCircuitBreakerCtx({ oscillationCount: 2, enabled: true, maxOscillations: 2 });
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    if (result.action !== "pause") throw new Error(`Expected pause, got ${result.action}`);
    expect((result as { action: string; reason: string }).reason).toContain("2");
  });

  test("AC-17: pause reason contains case-insensitive 'oscillat'", async () => {
    const ctx = makeCircuitBreakerCtx({ oscillationCount: 2, enabled: true, maxOscillations: 2 });
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    if (result.action !== "pause") throw new Error(`Expected pause, got ${result.action}`);
    expect((result as { action: string; reason: string }).reason.toLowerCase()).toContain("oscillat");
  });

  test("AC-18: count 1 < maxOscillations 2 → escalate (breaker below threshold)", async () => {
    const ctx = makeCircuitBreakerCtx({ oscillationCount: 1, enabled: true, maxOscillations: 2 });
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("AC-19: count >= maxOscillations but enabled=false → escalate (breaker disabled)", async () => {
    const ctx = makeCircuitBreakerCtx({ oscillationCount: 2, enabled: false, maxOscillations: 2 });
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("AC-20: ctx.runtime.rectificationOscillations absent → escalate (fail-open)", async () => {
    const ctx = makeCircuitBreakerCtx({ omitRuntime: true });
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("AC-21: count 0 < maxOscillations 2 → escalate (single-source unfixable finding)", async () => {
    const ctx = makeCircuitBreakerCtx({ oscillationCount: 0, enabled: true, maxOscillations: 2 });
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("AC-22: when breaker triggers, interaction.send is called with type 'notify'", async () => {
    const notifyCalls: unknown[] = [];
    const interaction = {
      send: mock(async (msg: unknown) => {
        notifyCalls.push(msg);
      }),
    };
    const ctx = makeCircuitBreakerCtx({
      oscillationCount: 2,
      enabled: true,
      maxOscillations: 2,
      interaction,
    });
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(result.action).toBe("pause");
    expect(notifyCalls.length).toBeGreaterThan(0);
    const firstMsg = notifyCalls[0] as Record<string, unknown>;
    expect(firstMsg.type).toBe("notify");
  });

  test("AC-23: interaction.send throws → decideStageAction still returns pause (throw not propagated)", async () => {
    const interaction = {
      send: mock(async () => {
        throw new Error("interaction send failed");
      }),
    };
    const ctx = makeCircuitBreakerCtx({
      oscillationCount: 2,
      enabled: true,
      maxOscillations: 2,
      interaction,
    });
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("pause");
  });
});