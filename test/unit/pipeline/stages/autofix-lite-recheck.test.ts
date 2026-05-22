/**
 * Unit tests for recheckReview lite mode and _autofixDeps.runReviewStage.
 *
 * Covers the new { lite?: boolean } option on recheckReview (AC1–6, AC13)
 * and the injectable runReviewStage dep (AC7–8).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import type { PipelineContext } from "@/pipeline/types";
import { DEFAULT_CONFIG } from "@/config";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: DEFAULT_CONFIG,
    rootConfig: DEFAULT_CONFIG,
    prd: { stories: [] } as any,
    story: { id: "US-001", title: "t", status: "in-progress", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: {} as any,
    ...overrides,
  };
}

function makePassingReviewResult() {
  return { success: true, checks: [], totalDurationMs: 0 } as any;
}

function makeFailingReviewResult(extra: Record<string, unknown> = {}) {
  return {
    success: false,
    checks: [
      { check: "lint", success: false, command: "biome", exitCode: 1, output: "err", durationMs: 10 },
    ],
    totalDurationMs: 0,
    ...extra,
  } as any;
}

function makeFailOpenReviewResult() {
  return {
    success: true,
    checks: [
      {
        check: "semantic",
        success: true,
        failOpen: true,
        command: "semantic",
        exitCode: 0,
        output: "",
        durationMs: 0,
      },
    ],
    totalDurationMs: 0,
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC2: recheckReview(ctx) and recheckReview(ctx, {}) — backward-compatible
// ─────────────────────────────────────────────────────────────────────────────

describe("recheckReview — backward-compatible non-lite behavior (AC2)", () => {
  let savedRunReviewStage: typeof _autofixDeps.runReviewStage;

  beforeEach(() => {
    savedRunReviewStage = _autofixDeps.runReviewStage;
  });

  afterEach(() => {
    _autofixDeps.runReviewStage = savedRunReviewStage;
  });

  test("returns true/false based on reviewResult.success — no opts and empty opts behave identically", async () => {
    _autofixDeps.runReviewStage = async (_c) => {};
    expect(await _autofixDeps.recheckReview(makeCtx({ reviewResult: makePassingReviewResult() }))).toBe(true);
    expect(await _autofixDeps.recheckReview(makeCtx({ reviewResult: makeFailingReviewResult() }))).toBe(false);
    expect(await _autofixDeps.recheckReview(makeCtx({ reviewResult: makePassingReviewResult() }), {})).toBe(true);
    expect(await _autofixDeps.recheckReview(makeCtx({ reviewResult: makeFailingReviewResult() }), {})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: lite=true augments retrySkipChecks with "adversarial" and "semantic"
// ─────────────────────────────────────────────────────────────────────────────

describe("recheckReview — lite mode augments retrySkipChecks (AC3)", () => {
  let savedRunReviewStage: typeof _autofixDeps.runReviewStage;
  let capturedSkipChecks: Set<string> | undefined;

  beforeEach(() => {
    savedRunReviewStage = _autofixDeps.runReviewStage;
    capturedSkipChecks = undefined;
  });

  afterEach(() => {
    _autofixDeps.runReviewStage = savedRunReviewStage;
  });

  test("adds 'adversarial' and 'semantic' to retrySkipChecks during the call", async () => {
    const ctx = makeCtx({ reviewResult: makePassingReviewResult() });
    _autofixDeps.runReviewStage = async (ctx) => {
      capturedSkipChecks = new Set(ctx.retrySkipChecks);
    };
    await _autofixDeps.recheckReview(ctx, { lite: true });
    expect(capturedSkipChecks?.has("adversarial")).toBe(true);
    expect(capturedSkipChecks?.has("semantic")).toBe(true);
  });

  test("preserves existing retrySkipChecks entries during the call", async () => {
    const ctx = makeCtx({
      reviewResult: makePassingReviewResult(),
      retrySkipChecks: new Set(["lint"]),
    });
    _autofixDeps.runReviewStage = async (ctx) => {
      capturedSkipChecks = new Set(ctx.retrySkipChecks);
    };
    await _autofixDeps.recheckReview(ctx, { lite: true });
    expect(capturedSkipChecks?.has("lint")).toBe(true);
    expect(capturedSkipChecks?.has("adversarial")).toBe(true);
    expect(capturedSkipChecks?.has("semantic")).toBe(true);
  });

  test("restores retrySkipChecks on success (undefined) + on success (Set) + on throw (undefined) + on throw (Set)", async () => {
    _autofixDeps.runReviewStage = async (_c) => {};
    const ctx1 = makeCtx({ reviewResult: makePassingReviewResult() });
    await _autofixDeps.recheckReview(ctx1, { lite: true });
    expect(ctx1.retrySkipChecks).toBeUndefined();

    const original = new Set(["lint"]);
    const ctx2 = makeCtx({ reviewResult: makePassingReviewResult(), retrySkipChecks: original });
    await _autofixDeps.recheckReview(ctx2, { lite: true });
    expect(ctx2.retrySkipChecks).toBe(original);
    expect(ctx2.retrySkipChecks?.size).toBe(1);

    _autofixDeps.runReviewStage = async () => { throw new Error("review failed"); };
    const ctx3 = makeCtx({ reviewResult: makeFailingReviewResult() });
    await expect(_autofixDeps.recheckReview(ctx3, { lite: true })).rejects.toThrow("review failed");
    expect(ctx3.retrySkipChecks).toBeUndefined();

    const original4 = new Set(["lint"]);
    const ctx4 = makeCtx({ reviewResult: makeFailingReviewResult(), retrySkipChecks: original4 });
    await expect(_autofixDeps.recheckReview(ctx4, { lite: true })).rejects.toThrow("review failed");
    expect(ctx4.retrySkipChecks).toBe(original4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: lite=true sets ctx.skipLLMReviewers=true and restores afterward
// ─────────────────────────────────────────────────────────────────────────────

describe("recheckReview — lite mode sets skipLLMReviewers (AC4)", () => {
  let savedRunReviewStage: typeof _autofixDeps.runReviewStage;
  let capturedSkipLLMReviewers: boolean | undefined;

  beforeEach(() => {
    savedRunReviewStage = _autofixDeps.runReviewStage;
    capturedSkipLLMReviewers = undefined;
  });

  afterEach(() => {
    _autofixDeps.runReviewStage = savedRunReviewStage;
  });

  test("sets ctx.skipLLMReviewers=true during the call", async () => {
    const ctx = makeCtx({ reviewResult: makePassingReviewResult() });
    _autofixDeps.runReviewStage = async (ctx) => {
      capturedSkipLLMReviewers = ctx.skipLLMReviewers;
    };
    await _autofixDeps.recheckReview(ctx, { lite: true });
    expect(capturedSkipLLMReviewers).toBe(true);
  });

  test("restores skipLLMReviewers on success (undefined) + on success (false) + on throw (undefined)", async () => {
    _autofixDeps.runReviewStage = async (_c) => {};
    const ctx1 = makeCtx({ reviewResult: makePassingReviewResult() });
    await _autofixDeps.recheckReview(ctx1, { lite: true });
    expect(ctx1.skipLLMReviewers).toBeUndefined();

    const ctx2 = makeCtx({ reviewResult: makePassingReviewResult(), skipLLMReviewers: false });
    await _autofixDeps.recheckReview(ctx2, { lite: true });
    expect(ctx2.skipLLMReviewers).toBe(false);

    _autofixDeps.runReviewStage = async () => { throw new Error("review stage error"); };
    const ctx3 = makeCtx({ reviewResult: makeFailingReviewResult() });
    await expect(_autofixDeps.recheckReview(ctx3, { lite: true })).rejects.toThrow("review stage error");
    expect(ctx3.skipLLMReviewers).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: lite=true with success=true returns true regardless of failOpen
// ─────────────────────────────────────────────────────────────────────────────

describe("recheckReview — lite mode returns true on success regardless of failOpen (AC5)", () => {
  let savedRunReviewStage: typeof _autofixDeps.runReviewStage;

  beforeEach(() => {
    savedRunReviewStage = _autofixDeps.runReviewStage;
  });

  afterEach(() => {
    _autofixDeps.runReviewStage = savedRunReviewStage;
  });

  test("returns true when reviewResult.success=true even with failOpen check present", async () => {
    const ctx = makeCtx({ reviewResult: makeFailOpenReviewResult() });
    _autofixDeps.runReviewStage = async (_c) => {};
    const result = await _autofixDeps.recheckReview(ctx, { lite: true });
    expect(result).toBe(true);
  });

  test("returns false when reviewResult.success=false in lite mode", async () => {
    const ctx = makeCtx({ reviewResult: makeFailingReviewResult() });
    _autofixDeps.runReviewStage = async (_c) => {};
    const result = await _autofixDeps.recheckReview(ctx, { lite: true });
    expect(result).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 + AC6: non-lite failOpen returns false and does NOT mutate ctx
// ─────────────────────────────────────────────────────────────────────────────

describe("recheckReview — non-lite failOpen returns false, no mutation (AC1, AC6)", () => {
  let savedRunReviewStage: typeof _autofixDeps.runReviewStage;

  beforeEach(() => {
    savedRunReviewStage = _autofixDeps.runReviewStage;
  });

  afterEach(() => {
    _autofixDeps.runReviewStage = savedRunReviewStage;
  });

  test("returns false for failOpen (lite not set, lite=false); does not mutate retrySkipChecks or skipLLMReviewers", async () => {
    _autofixDeps.runReviewStage = async (_c) => {};
    const ctx = makeCtx({ reviewResult: makeFailOpenReviewResult() });
    expect(await _autofixDeps.recheckReview(ctx)).toBe(false);
    expect(await _autofixDeps.recheckReview(ctx, { lite: false })).toBe(false);
    expect(ctx.retrySkipChecks).toBeUndefined();
    expect(ctx.skipLLMReviewers).toBeUndefined();
  });

  test("skipLLMReviewers unset behaves identically to false (AC1)", async () => {
    const ctxUnset = makeCtx({ reviewResult: makePassingReviewResult() });
    const ctxFalse = makeCtx({ reviewResult: makePassingReviewResult(), skipLLMReviewers: false });
    _autofixDeps.runReviewStage = async (_c) => {};
    const resultUnset = await _autofixDeps.recheckReview(ctxUnset);
    const resultFalse = await _autofixDeps.recheckReview(ctxFalse);
    expect(resultUnset).toBe(resultFalse);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13: throw propagated after restore
// ─────────────────────────────────────────────────────────────────────────────

describe("recheckReview — lite mode propagates throw after restoring ctx (AC13)", () => {
  let savedRunReviewStage: typeof _autofixDeps.runReviewStage;

  beforeEach(() => {
    savedRunReviewStage = _autofixDeps.runReviewStage;
  });

  afterEach(() => {
    _autofixDeps.runReviewStage = savedRunReviewStage;
  });

  test("propagates error from runReviewStage and ctx is fully restored", async () => {
    const originalSkipChecks = new Set(["lint"]);
    const ctx = makeCtx({
      reviewResult: makeFailingReviewResult(),
      retrySkipChecks: originalSkipChecks,
      skipLLMReviewers: false,
    });
    _autofixDeps.runReviewStage = async () => {
      throw new Error("runReviewStage threw");
    };
    await expect(_autofixDeps.recheckReview(ctx, { lite: true })).rejects.toThrow("runReviewStage threw");
    // retrySkipChecks restored
    expect(ctx.retrySkipChecks).toBe(originalSkipChecks);
    expect(ctx.retrySkipChecks?.size).toBe(1);
    // skipLLMReviewers restored
    expect(ctx.skipLLMReviewers).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: _autofixDeps.runReviewStage wraps dynamic import and calls execute
// AC8: _autofixDeps.runReviewStage returns when enabled=false
// ─────────────────────────────────────────────────────────────────────────────

describe("_autofixDeps.runReviewStage (AC7, AC8)", () => {
  test("exists as function; resolves when disabled; resolves when enabled (AC7, AC8)", async () => {
    expect(typeof _autofixDeps.runReviewStage).toBe("function");
    await expect(_autofixDeps.runReviewStage(makeCtx({ config: { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, enabled: false } } as any }))).resolves.toBeUndefined();
    await expect(_autofixDeps.runReviewStage(makeCtx({ config: { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, enabled: true } } as any }))).resolves.toBeUndefined();
  });
});
