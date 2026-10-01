/**
 * Direct tests for `inspectRecurrenceBreaker` — #1666 Part C.
 *
 * Mirrors `oscillation-breaker.test.ts`'s structure for the parallel
 * cross-attempt counter: same fail-open contract, same config shape
 * (`review.conflictDetection`), different runtime map and threshold field.
 */
import { describe, expect, test } from "bun:test";
import { makeTestContext, makeTestRuntime, makeTestStory } from "@test/helpers";
import { inspectRecurrenceBreaker, type ReviewRecurrenceStore, recordReviewFindings } from "@/execution";
import type { Finding } from "@/findings";
import type { PipelineContext } from "@/pipeline/types";

function makeCtx(
  overrides: {
    storyId?: string;
    store?: ReviewRecurrenceStore | undefined;
    conflictDetection?: { enabled: boolean; maxCrossAttemptRecurrences?: number } | undefined;
    omitRuntime?: boolean;
  } = {},
): PipelineContext {
  const storyId = overrides.storyId ?? "US-rec-1";
  const ctx = makeTestContext({
    story: makeTestStory({ id: storyId, title: "Recurrence breaker unit" }),
  });
  const hasConflictDetectionOverride = Object.hasOwn(overrides, "conflictDetection");
  ctx.config = {
    ...ctx.config,
    review: {
      ...ctx.config.review,
      conflictDetection: hasConflictDetectionOverride
        ? overrides.conflictDetection
        : { enabled: true, maxCrossAttemptRecurrences: 2 },
    },
  } as typeof ctx.config;

  if (overrides.omitRuntime === true) {
    Object.defineProperty(ctx, "runtime", {
      value: undefined,
      configurable: true,
    });
  } else {
    const sharedRuntime = makeTestRuntime();
    if (Object.hasOwn(overrides, "store")) {
      Object.defineProperty(sharedRuntime, "reviewFindingRecurrences", {
        value: overrides.store,
        configurable: true,
      });
    }
    Object.defineProperty(ctx, "runtime", {
      value: sharedRuntime,
      configurable: true,
    });
  }

  return ctx;
}

function seedRecurrence(source: Finding["source"], count: number): ReviewRecurrenceStore {
  const store: ReviewRecurrenceStore = new Map();
  const finding: Finding = { source, severity: "error", category: "test", message: "same", rule: "R1", file: "f.ts" };
  for (let i = 0; i <= count; i++) {
    recordReviewFindings(store, "US-rec-1", source, [finding]);
  }
  return store;
}

describe("inspectRecurrenceBreaker — fail-open paths", () => {
  test("missing conflictDetection config → trip=false, default maxCrossAttemptRecurrences reported", () => {
    const ctx = makeCtx({ conflictDetection: undefined });
    const decision = inspectRecurrenceBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.maxCrossAttemptRecurrences).toBe(2);
    expect(decision.reason).toBe("");
  });

  test("conflictDetection.enabled === false → trip=false even with a high count", () => {
    const store = seedRecurrence("semantic-review", 5);
    const ctx = makeCtx({ store, conflictDetection: { enabled: false, maxCrossAttemptRecurrences: 2 } });
    const decision = inspectRecurrenceBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.count).toBe(0);
  });

  test("runtime.reviewFindingRecurrences absent → trip=false", () => {
    const ctx = makeCtx({ store: undefined, conflictDetection: { enabled: true, maxCrossAttemptRecurrences: 2 } });
    const decision = inspectRecurrenceBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.reason).toBe("");
  });

  test("ctx.runtime missing entirely → trip=false", () => {
    const ctx = makeCtx({ omitRuntime: true });
    const decision = inspectRecurrenceBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.reason).toBe("");
  });
});

describe("inspectRecurrenceBreaker — trip paths", () => {
  test("a reviewer's first-ever appearance never trips the breaker, regardless of finding count", () => {
    const store: ReviewRecurrenceStore = new Map();
    recordReviewFindings(store, "US-rec-1", "adversarial-review", [
      { source: "adversarial-review", severity: "error", category: "test", message: "m", rule: "R1", file: "f.ts" },
    ]);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxCrossAttemptRecurrences: 2 } });
    const decision = inspectRecurrenceBreaker(ctx);
    expect(decision.trip).toBe(false);
  });

  test("count === maxCrossAttemptRecurrences → trip=true (boundary)", () => {
    const store = seedRecurrence("semantic-review", 2);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxCrossAttemptRecurrences: 2 } });
    const decision = inspectRecurrenceBreaker(ctx);
    expect(decision.trip).toBe(true);
    expect(decision.count).toBe(2);
    expect(decision.source).toBe("semantic-review");
  });

  test("count < maxCrossAttemptRecurrences → trip=false", () => {
    const store = seedRecurrence("semantic-review", 0);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxCrossAttemptRecurrences: 2 } });
    const decision = inspectRecurrenceBreaker(ctx);
    expect(decision.trip).toBe(false);
  });

  test("trips on adversarial-review recurrence just as it does on semantic-review", () => {
    const store = seedRecurrence("adversarial-review", 2);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxCrossAttemptRecurrences: 2 } });
    const decision = inspectRecurrenceBreaker(ctx);
    expect(decision.trip).toBe(true);
    expect(decision.source).toBe("adversarial-review");
  });
});

describe("inspectRecurrenceBreaker — reason text", () => {
  test("distinguishes a reviewer deadlock from an implementer-can't-fix reason", () => {
    const store = seedRecurrence("semantic-review", 2);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxCrossAttemptRecurrences: 2 } });
    const decision = inspectRecurrenceBreaker(ctx);
    expect(decision.reason).toMatch(/deadlock/i);
    expect(decision.reason).toMatch(/reviewers? disagree/i);
    // Explicitly names the OTHER hypothesis it is ruling out, so an operator reading
    // the pause reason cannot mistake this for the plain "implementer can't fix it" case.
    expect(decision.reason).toMatch(/not the implementer failing to fix/i);
  });
});
