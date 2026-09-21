import { describe, expect, test } from "bun:test";
import { MIN_SCORE, scoreChunk, scoreChunks } from "@/context/engine/scoring";
import type { RawChunk } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return {
    id: "test:abc123",
    kind: "feature",
    scope: "feature",
    role: ["implementer"],
    content: "some content",
    tokens: 100,
    rawScore: 1.0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreChunk
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunk", () => {
  test("role match: returns full adjusted score", () => {
    const chunk = makeChunk({ role: ["implementer"], rawScore: 1.0, kind: "feature" });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=1.0, kindWeight=1.0, freshness=1.0
    expect(result.score).toBeCloseTo(1.0);
    expect(result.roleFiltered).toBe(false);
    expect(result.belowMinScore).toBe(false);
  });

  test("role=all: applies slight discount (0.9 × kindWeight)", () => {
    const chunk = makeChunk({ role: ["all"], rawScore: 1.0, kind: "feature" });
    const result = scoreChunk(chunk, "reviewer");
    expect(result.score).toBeCloseTo(0.9);
    expect(result.roleFiltered).toBe(false);
  });

  test("role mismatch: roleFiltered=true, score=0", () => {
    const chunk = makeChunk({ role: ["reviewer"], rawScore: 1.0 });
    const result = scoreChunk(chunk, "implementer");
    expect(result.roleFiltered).toBe(true);
    expect(result.score).toBe(0);
  });

  test("static kind: kindWeight=1.0", () => {
    const chunk = makeChunk({ role: ["all"], rawScore: 0.8, kind: "static" });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=0.9 (all→implementer), kindWeight=1.0
    expect(result.score).toBeCloseTo(0.72);
  });

  test("rag kind: kindWeight=0.7", () => {
    const chunk = makeChunk({ role: ["implementer"], rawScore: 1.0, kind: "rag" });
    const result = scoreChunk(chunk, "implementer");
    expect(result.score).toBeCloseTo(0.7);
  });

  test("AC3: diagnostics kind: kindWeight=0.95", () => {
    const chunk = makeChunk({ role: ["implementer"], rawScore: 1.0, kind: "diagnostics" });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=1.0, kindWeight=0.95, freshness=1.0
    expect(result.score).toBeCloseTo(0.95);
  });

  test("AC4: session kind: kindWeight=0.9", () => {
    const chunk = makeChunk({ role: ["implementer"], rawScore: 1.0, kind: "session" });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=1.0, kindWeight=0.9, freshness=1.0
    expect(result.score).toBeCloseTo(0.9);
  });

  test("staleness penalty: halves the score", () => {
    const chunk = makeChunk({ role: ["implementer"], rawScore: 1.0, kind: "feature" });
    // Pass minScore=MIN_SCORE explicitly, stale as 4th arg
    const fresh = scoreChunk(chunk, "implementer", MIN_SCORE, false);
    const stale = scoreChunk(chunk, "implementer", MIN_SCORE, true);
    expect(stale.score).toBeCloseTo(fresh.score * 0.5);
  });

  test("below minScore: belowMinScore=true when not role-filtered", () => {
    const chunk = makeChunk({ role: ["implementer"], rawScore: 0.05, kind: "rag" });
    // score = 0.05 × 1.0 × 0.7 = 0.035 < 0.1
    const result = scoreChunk(chunk, "implementer");
    expect(result.belowMinScore).toBe(true);
    expect(result.roleFiltered).toBe(false);
  });

  test("role-filtered chunk is NOT marked belowMinScore", () => {
    const chunk = makeChunk({ role: ["reviewer"], rawScore: 0.01, kind: "rag" });
    const result = scoreChunk(chunk, "implementer");
    expect(result.roleFiltered).toBe(true);
    expect(result.belowMinScore).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreChunks
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunks", () => {
  test("scores all chunks in parallel", () => {
    const chunks: RawChunk[] = [
      makeChunk({ id: "a:1", role: ["implementer"], rawScore: 0.9 }),
      makeChunk({ id: "b:1", role: ["reviewer"], rawScore: 0.9 }),
      makeChunk({ id: "c:1", role: ["all"], rawScore: 1.0 }),
    ];
    const results = scoreChunks(chunks, "implementer");
    expect(results).toHaveLength(3);
    expect(results[0].roleFiltered).toBe(false);
    expect(results[1].roleFiltered).toBe(true);
    expect(results[2].roleFiltered).toBe(false);
  });

  test("preserves input order", () => {
    const ids = ["x:1", "y:1", "z:1"];
    const chunks = ids.map((id) => makeChunk({ id }));
    const results = scoreChunks(chunks, "implementer");
    expect(results.map((r) => r.id)).toEqual(ids);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MIN_SCORE constant
// ─────────────────────────────────────────────────────────────────────────────

describe("MIN_SCORE", () => {
  test("is 0.1 in Phase 0", () => {
    expect(MIN_SCORE).toBe(0.1);
  });
});

/**
 * scoring.ts — US-004 effectiveness weights during scoring tests
 *
 * Covers AC1–AC4 of US-004. The story threads feature-derived provider
 * weights from the V2 context stage through `ContextRequest` and into
 * `scoreChunk` / `scoreChunks`.
 *
 * AC1: scoreChunk(chunk, …, weights) with a weight below 1.0 for chunk.providerId
 *      → score equals score-without-weights × that weight.
 * AC2: scoreChunk(chunk, …, weights) where weights omit chunk.providerId
 *      → score equals score with no weights supplied.
 * AC3: scoreChunk(chunk, …) with no weights
 *      → score equals rawScore × role × kind × freshness.
 * AC4: scoreChunks([c1, c2]) where c1.providerId ≠ c2.providerId and each has its own
 *      weight → returns different scores reflecting each chunk's provider weight.
 *
 * The current stub accepts the new 5th parameter (`providerWeights`) but does
 * not yet apply it, so:
 *   - AC1: fails — score is unchanged, not multiplied by the weight.
 *   - AC2: passes — weights are absent from the chunk's perspective (same result).
 *   - AC3: passes — existing role × kind × freshness formula.
 *   - AC4: fails — both chunks score identically because weights are ignored.
 *
 * AC2 and AC3 document behaviour the implementer must preserve (identity when
 * weights are absent / omitted). AC1 and AC4 will turn green once the stub
 * multiplies the score by the keyed weight.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeWeightsChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return {
    id: "test:abc123",
    providerId: "p1",
    kind: "feature",
    scope: "feature",
    role: ["implementer"],
    content: "some content",
    tokens: 100,
    rawScore: 1.0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC3: scoreChunk with no weights preserves the existing formula
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunk — no weights (AC3)", () => {
  test("AC3: scoreChunk with no weights returns rawScore × role × kind × freshness", () => {
    // role=implementer, kind=feature, roleMultiplier=1.0, kindWeight=1.0, freshness=1.0
    const chunk = makeWeightsChunk({ rawScore: 1.0, kind: "feature", role: ["implementer"] });
    const result = scoreChunk(chunk, "implementer");
    // AC3 must hold for the current (unchanged) implementation.
    expect(result.score).toBeCloseTo(1.0);
  });

  test("AC3 (rag kind): score is rawScore × role × 0.7 × freshness when no weights supplied", () => {
    const chunk = makeWeightsChunk({ rawScore: 1.0, kind: "rag", role: ["implementer"] });
    const result = scoreChunk(chunk, "implementer");
    expect(result.score).toBeCloseTo(0.7);
  });

  test("AC3 (stale): score halves when stale=true and no weights supplied", () => {
    const chunk = makeWeightsChunk({ rawScore: 1.0, kind: "feature", role: ["implementer"] });
    const fresh = scoreChunk(chunk, "implementer", undefined, false);
    const stale = scoreChunk(chunk, "implementer", undefined, true);
    expect(stale.score).toBeCloseTo(fresh.score * 0.5);
  });

  test("AC3 (role=all): slight discount × kind × freshness when no weights supplied", () => {
    const chunk = makeWeightsChunk({ rawScore: 1.0, kind: "feature", role: ["all"] });
    const result = scoreChunk(chunk, "implementer");
    expect(result.score).toBeCloseTo(0.9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: scoreChunk with weights that omit chunk.providerId → identity
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunk — weights omit providerId (AC2)", () => {
  test("AC2: weights map a different provider → score equals the no-weights score", () => {
    const chunk = makeWeightsChunk({ rawScore: 1.0, kind: "feature", providerId: "p1" });
    const without = scoreChunk(chunk, "implementer");
    const withOtherProviderWeight = scoreChunk(chunk, "implementer", undefined, false, {
      someOtherProvider: 0.5,
    });
    // AC2: weights that don't include chunk.providerId must be ignored — score unchanged.
    expect(withOtherProviderWeight.score).toBeCloseTo(without.score);
  });

  test("AC2 (empty map): empty weight object is equivalent to no weights", () => {
    const chunk = makeWeightsChunk({ rawScore: 0.8, kind: "rag", providerId: "p1" });
    const without = scoreChunk(chunk, "implementer");
    const withEmpty = scoreChunk(chunk, "implementer", undefined, false, {});
    expect(withEmpty.score).toBeCloseTo(without.score);
  });

  test("AC2 (boundary): chunk without providerId → weights are always ignored", () => {
    // No providerId set on the chunk — even if the weights map names the chunk's
    // synthetic id, the lookup must miss (chunk.providerId is undefined).
    const chunk = makeWeightsChunk({ rawScore: 0.7, kind: "rag" });
    delete (chunk as { providerId?: string }).providerId;
    const without = scoreChunk(chunk, "implementer");
    const withRandom = scoreChunk(chunk, "implementer", undefined, false, { anything: 0.1 });
    expect(withRandom.score).toBeCloseTo(without.score);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: scoreChunk multiplies by providerWeight for chunk.providerId
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunk — weights include providerId below 1.0 (AC1)", () => {
  test("AC1: weight 0.5 for chunk.providerId → score = score-without-weights × 0.5", () => {
    const chunk = makeWeightsChunk({ rawScore: 1.0, kind: "feature", providerId: "p1" });
    const without = scoreChunk(chunk, "implementer");
    const withHalf = scoreChunk(chunk, "implementer", undefined, false, { p1: 0.5 });
    expect(withHalf.score).toBeCloseTo(without.score * 0.5);
  });

  test("AC1 (weight 0.2): score = score-without-weights × 0.2", () => {
    const chunk = makeWeightsChunk({ rawScore: 1.0, kind: "feature", providerId: "p1" });
    const without = scoreChunk(chunk, "implementer");
    const withLow = scoreChunk(chunk, "implementer", undefined, false, { p1: 0.2 });
    expect(withLow.score).toBeCloseTo(without.score * 0.2);
  });

  test("AC1 (non-feature kind): weight applied multiplicatively on top of role × kind × freshness", () => {
    const chunk = makeWeightsChunk({ rawScore: 1.0, kind: "rag", providerId: "rag-provider" });
    const without = scoreChunk(chunk, "implementer");
    const withHalf = scoreChunk(chunk, "implementer", undefined, false, { "rag-provider": 0.5 });
    // base = 1.0 × 1.0 × 0.7 × 1.0 = 0.7 ; with 0.5 weight → 0.35
    expect(without.score).toBeCloseTo(0.7);
    expect(withHalf.score).toBeCloseTo(without.score * 0.5);
  });

  test("AC1 (weight 1.0): score unchanged when weight is identity", () => {
    const chunk = makeWeightsChunk({ rawScore: 0.6, kind: "feature", providerId: "p1" });
    const without = scoreChunk(chunk, "implementer");
    const withOne = scoreChunk(chunk, "implementer", undefined, false, { p1: 1.0 });
    expect(withOne.score).toBeCloseTo(without.score);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: scoreChunks applies per-provider weights to chunks from different providers
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunks — differing weights per provider (AC4)", () => {
  test("AC4: two equal chunks from different providers with different weights → different scores", () => {
    const chunkA = makeWeightsChunk({
      id: "a:1",
      rawScore: 1.0,
      kind: "feature",
      providerId: "p1",
    });
    const chunkB = makeWeightsChunk({
      id: "b:1",
      rawScore: 1.0,
      kind: "feature",
      providerId: "p2",
    });
    const weights = { p1: 0.5, p2: 0.9 };
    const [scoredA, scoredB] = scoreChunks([chunkA, chunkB], "implementer", undefined, weights);
    expect(scoredA.score).not.toBeCloseTo(scoredB.score);
    // p1 should be the smaller one (0.5 vs 0.9).
    expect(scoredA.score).toBeLessThan(scoredB.score);
  });

  test("AC4: weight 0.5 vs 1.0 → chunk with weight 0.5 scores half of the other", () => {
    const chunkA = makeWeightsChunk({ id: "a:1", rawScore: 1.0, kind: "feature", providerId: "p1" });
    const chunkB = makeWeightsChunk({ id: "b:1", rawScore: 1.0, kind: "feature", providerId: "p2" });
    const weights = { p1: 0.5, p2: 1.0 };
    const [scoredA, scoredB] = scoreChunks([chunkA, chunkB], "implementer", undefined, weights);
    expect(scoredA.score).toBeCloseTo(scoredB.score * 0.5);
  });

  test("AC4 (preserves order): scoreChunks returns results in input order regardless of weights", () => {
    const chunkA = makeWeightsChunk({ id: "first:1", rawScore: 0.7, kind: "feature", providerId: "p1" });
    const chunkB = makeWeightsChunk({ id: "second:1", rawScore: 0.7, kind: "feature", providerId: "p2" });
    const weights = { p1: 0.1, p2: 0.9 };
    const [first, second] = scoreChunks([chunkA, chunkB], "implementer", undefined, weights);
    expect(first.id).toBe("first:1");
    expect(second.id).toBe("second:1");
  });

  test("AC4 (omitted provider): chunk whose providerId is missing from weights gets identity score", () => {
    const chunkA = makeWeightsChunk({ id: "a:1", rawScore: 1.0, kind: "feature", providerId: "p1" });
    const chunkB = makeWeightsChunk({ id: "b:1", rawScore: 1.0, kind: "feature", providerId: "p2" });
    const weights = { p1: 0.5 }; // p2 omitted
    const withoutWeights = scoreChunks([chunkA, chunkB], "implementer");
    const withWeights = scoreChunks([chunkA, chunkB], "implementer", undefined, weights);
    // chunkB's providerId is omitted → must equal the no-weight score.
    expect(withWeights[1].score).toBeCloseTo(withoutWeights[1].score);
    // chunkA's providerId is keyed → scored at 0.5× the no-weight score.
    expect(withWeights[0].score).toBeCloseTo(withoutWeights[0].score * 0.5);
  });
});

/**
 * scoring.ts — US-004 LintConfigProvider kind weight tests
 *
 * AC3: When scoreChunk scores a lint-config chunk, then it applies kind weight 0.8.
 * AC4: When scoreChunk scores a static chunk, then it applies kind weight 1.0.
 *
 * Mirrors the prior scoring-kind tests for diagnostics (0.95), session (0.9),
 * and prior-failure (0.85).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeLintConfigChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return {
    id: "lint-config:abc123",
    kind: "lint-config",
    scope: "project",
    role: ["implementer"],
    content: "some content",
    tokens: 100,
    rawScore: 1.0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — kind weight 0.8 for lint-config
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunk — lint-config kind (US-004 AC3)", () => {
  test("AC3: kind weight 0.8 applies to a lint-config chunk", () => {
    const chunk = makeLintConfigChunk({ rawScore: 1.0, kind: "lint-config" });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=1.0, kindWeight=0.8, freshness=1.0
    expect(result.score).toBeCloseTo(0.8);
  });

  test("AC3: kind weight 0.8 applies with role=all", () => {
    const chunk = makeLintConfigChunk({ rawScore: 1.0, kind: "lint-config", role: ["all"] });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=0.9 (all→implementer), kindWeight=0.8
    expect(result.score).toBeCloseTo(0.9 * 0.8);
  });

  test("AC3: kind weight 0.8 produces higher score than neighbor (0.75) and lower than prior-failure (0.85)", () => {
    // Sanity-check the ordering vs the existing kind weights.
    const lint = scoreChunk(makeLintConfigChunk({ kind: "lint-config", rawScore: 1.0 }), "implementer").score;
    const prior = scoreChunk(makeLintConfigChunk({ kind: "prior-failure", rawScore: 1.0 }), "implementer").score;
    const neighbor = scoreChunk(makeLintConfigChunk({ kind: "neighbor", rawScore: 1.0 }), "implementer").score;
    expect(lint).toBeGreaterThan(neighbor);
    expect(lint).toBeLessThan(prior);
    expect(lint).toBeCloseTo(0.8);
  });

  test("AC3: lint-config chunk is below the static floor weight (0.8 < 1.0)", () => {
    const lint = scoreChunk(makeLintConfigChunk({ kind: "lint-config", rawScore: 1.0 }), "implementer").score;
    const staticScore = scoreChunk({ ...makeLintConfigChunk({ kind: "static", rawScore: 1.0 }) }, "implementer").score;
    expect(lint).toBeLessThan(staticScore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — static kind weight is unchanged at 1.0
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunk — static kind unchanged (US-004 AC4)", () => {
  test("AC4: kind weight 1.0 still applies to a static chunk", () => {
    const chunk: RawChunk = {
      id: "static-rules:abc",
      kind: "static",
      scope: "project",
      role: ["implementer"],
      content: "rule content",
      tokens: 100,
      rawScore: 1.0,
    };
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=1.0, kindWeight=1.0, freshness=1.0
    expect(result.score).toBeCloseTo(1.0);
  });

  test("AC4: static kind weight 1.0 with role=all", () => {
    const chunk: RawChunk = {
      id: "static-rules:abc",
      kind: "static",
      scope: "project",
      role: ["all"],
      content: "rule content",
      tokens: 100,
      rawScore: 1.0,
    };
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=0.9 (all→implementer), kindWeight=1.0
    expect(result.score).toBeCloseTo(0.9 * 1.0);
  });

  test("AC4: rawScore propagates with static kind", () => {
    const chunk: RawChunk = {
      id: "static-rules:abc",
      kind: "static",
      scope: "project",
      role: ["all"],
      content: "rule content",
      tokens: 100,
      rawScore: 0.5,
    };
    const result = scoreChunk(chunk, "implementer");
    // 0.5 × 0.9 × 1.0 = 0.45
    expect(result.score).toBeCloseTo(0.45);
  });
});

/**
 * scoring.ts — US-003 PriorRunFailureProvider kind weight tests
 *
 * AC3: When scoreChunk scores a prior-failure chunk, then it applies kind weight 0.85.
 *
 * Mirrors the prior scoring-kind tests for diagnostics (0.95) and session (0.9).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePriorFailureChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return {
    id: "prior-run-failure:abc123",
    kind: "prior-failure",
    scope: "story",
    role: ["implementer"],
    content: "some content",
    tokens: 100,
    rawScore: 1.0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — kind weight 0.85 for prior-failure
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunk — prior-failure kind (US-003 AC3)", () => {
  test("AC3: kind weight 0.85 applies to a prior-failure chunk", () => {
    const chunk = makePriorFailureChunk({ rawScore: 1.0, kind: "prior-failure" });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=1.0, kindWeight=0.85, freshness=1.0
    expect(result.score).toBeCloseTo(0.85);
  });

  test("AC3: kind weight 0.85 applies with role=all", () => {
    const chunk = makePriorFailureChunk({ rawScore: 1.0, kind: "prior-failure", role: ["all"] });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=0.9 (all→implementer), kindWeight=0.85
    expect(result.score).toBeCloseTo(0.9 * 0.85);
  });

  test("AC3: kind weight 0.85 applies multiplicatively with role mismatch score=0", () => {
    const chunk = makePriorFailureChunk({ rawScore: 1.0, kind: "prior-failure", role: ["reviewer"] });
    const result = scoreChunk(chunk, "implementer");
    expect(result.roleFiltered).toBe(true);
    expect(result.score).toBe(0);
  });

  test("AC3: kind weight 0.85 produces higher score than rag (0.7) and lower than session (0.9)", () => {
    // Sanity-check the ordering vs the existing kind weights.
    const prior = scoreChunk(makePriorFailureChunk({ kind: "prior-failure", rawScore: 1.0 }), "implementer").score;
    const session = scoreChunk(makePriorFailureChunk({ kind: "session", rawScore: 1.0 }), "implementer").score;
    const rag = scoreChunk(makePriorFailureChunk({ kind: "rag", rawScore: 1.0 }), "implementer").score;
    expect(prior).toBeGreaterThan(rag);
    expect(prior).toBeLessThan(session);
    expect(prior).toBeCloseTo(0.85);
  });
});
