/**
 * Direct tests for `inspectOscillationBreaker` (US-002).
 *
 * The breaker's threshold, key-selection, and fail-open paths are pure
 * and worth isolating from the decideStageAction seam — a regression in
 * any of them should fail this file even if the orchestrator-level
 * integration test still passes.
 */

import { describe, expect, test } from "bun:test";
import { makeTestContext, makeTestRuntime, makeTestStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { inspectOscillationBreaker, recordOscillations } from "@/execution";
import type { PipelineContext } from "@/pipeline/types";

function makeCtx(
  overrides: {
    storyId?: string;
    store?: Map<string, number> | undefined;
    conflictDetection?: { enabled: boolean; maxOscillations?: number } | undefined;
    omitRuntime?: boolean;
  } = {},
): PipelineContext {
  const storyId = overrides.storyId ?? "US-osc-1";
  const ctx = makeTestContext({
    story: makeTestStory({ id: storyId, title: "Breaker unit" }),
  });
  const hasConflictDetectionOverride = Object.hasOwn(overrides, "conflictDetection");
  ctx.config = {
    ...ctx.config,
    review: {
      ...ctx.config.review,
      conflictDetection: hasConflictDetectionOverride
        ? overrides.conflictDetection
        : { enabled: true, maxOscillations: 2 },
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
      Object.defineProperty(sharedRuntime, "rectificationOscillations", {
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

describe("inspectOscillationBreaker — fail-open paths", () => {
  test("missing conflictDetection config → trip=false, default maxOscillations reported", () => {
    const ctx = makeCtx({ conflictDetection: undefined });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.maxOscillations).toBe(2);
    expect(decision.reason).toBe("");
  });

  test("conflictDetection.enabled === false → trip=false even with high count", () => {
    const store = new Map<string, number>([["US-osc-1", 100]]);
    const ctx = makeCtx({ store, conflictDetection: { enabled: false, maxOscillations: 2 } });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.count).toBe(0);
    expect(decision.maxOscillations).toBe(2);
  });

  test("runtime.rectificationOscillations absent → trip=false", () => {
    const ctx = makeCtx({ store: undefined, conflictDetection: { enabled: true, maxOscillations: 2 } });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.count).toBe(0);
    expect(decision.reason).toBe("");
  });

  test("ctx.runtime missing entirely → trip=false", () => {
    const ctx = makeCtx({ omitRuntime: true });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.reason).toBe("");
  });
});

describe("inspectOscillationBreaker — trip paths", () => {
  test("count === maxOscillations → trip=true (boundary)", () => {
    const store = new Map<string, number>([["US-osc-1", 2]]);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxOscillations: 2 } });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(true);
    expect(decision.count).toBe(2);
    expect(decision.maxOscillations).toBe(2);
    expect(decision.reason).toContain("2");
  });

  test("count > maxOscillations → trip=true", () => {
    const store = new Map<string, number>([["US-osc-1", 5]]);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxOscillations: 2 } });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(true);
    expect(decision.count).toBe(5);
  });

  test("count < maxOscillations → trip=false", () => {
    const store = new Map<string, number>([["US-osc-1", 1]]);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxOscillations: 2 } });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.count).toBe(1);
  });

  test("count === 0 → trip=false", () => {
    const store = new Map<string, number>([["US-osc-1", 0]]);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxOscillations: 2 } });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(false);
  });
});

describe("inspectOscillationBreaker — key selection", () => {
  test("only the storyId on ctx.story.id is consulted; other entries are ignored", () => {
    const store = new Map<string, number>([
      ["US-other", 999],
      ["US-osc-1", 2],
    ]);
    const ctx = makeCtx({ storyId: "US-osc-1", store, conflictDetection: { enabled: true, maxOscillations: 2 } });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(true);
    expect(decision.count).toBe(2);
  });

  test("unseen storyId reads 0 from an empty store", () => {
    const store = new Map<string, number>();
    const ctx = makeCtx({ storyId: "US-uncounted", store, conflictDetection: { enabled: true, maxOscillations: 2 } });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(false);
    expect(decision.count).toBe(0);
  });
});

describe("inspectOscillationBreaker — end-to-end with recordOscillations", () => {
  test("drives trip=true through the production writers", () => {
    const sharedRuntime = makeTestRuntime();
    const ctx = makeCtx({ conflictDetection: { enabled: true, maxOscillations: 2 } });
    Object.defineProperty(ctx, "runtime", {
      value: sharedRuntime,
      configurable: true,
    });

    recordOscillations(sharedRuntime.rectificationOscillations, "US-osc-1", 2);
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.trip).toBe(true);
    expect(decision.count).toBe(2);
  });
});

describe("inspectOscillationBreaker — reason text", () => {
  test("includes the count and a case-insensitive 'oscillat' substring when trip=true", () => {
    const store = new Map<string, number>([["US-osc-1", 2]]);
    const ctx = makeCtx({ store, conflictDetection: { enabled: true, maxOscillations: 2 } });
    const decision = inspectOscillationBreaker(ctx);
    expect(decision.reason).toContain("2");
    expect(decision.reason).toMatch(/oscillat/i);
  });
});

describe("DEFAULT_CONFIG — sanity", () => {
  test("DEFAULT_CONFIG has conflictDetection default-on with maxOscillations=2", () => {
    const conflictDetection = (
      DEFAULT_CONFIG as { review?: { conflictDetection?: { enabled: boolean; maxOscillations: number } } }
    ).review?.conflictDetection;
    expect(conflictDetection?.enabled).toBe(true);
    expect(conflictDetection?.maxOscillations).toBe(2);
  });
});
