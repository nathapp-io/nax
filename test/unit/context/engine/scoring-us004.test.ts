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

import { describe, expect, test } from "bun:test";
import { scoreChunk, scoreChunks } from "@/context/engine";
import type { RawChunk } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
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
    const chunk = makeChunk({ rawScore: 1.0, kind: "feature", role: ["implementer"] });
    const result = scoreChunk(chunk, "implementer");
    // AC3 must hold for the current (unchanged) implementation.
    expect(result.score).toBeCloseTo(1.0);
  });

  test("AC3 (rag kind): score is rawScore × role × 0.7 × freshness when no weights supplied", () => {
    const chunk = makeChunk({ rawScore: 1.0, kind: "rag", role: ["implementer"] });
    const result = scoreChunk(chunk, "implementer");
    expect(result.score).toBeCloseTo(0.7);
  });

  test("AC3 (stale): score halves when stale=true and no weights supplied", () => {
    const chunk = makeChunk({ rawScore: 1.0, kind: "feature", role: ["implementer"] });
    const fresh = scoreChunk(chunk, "implementer", undefined, false);
    const stale = scoreChunk(chunk, "implementer", undefined, true);
    expect(stale.score).toBeCloseTo(fresh.score * 0.5);
  });

  test("AC3 (role=all): slight discount × kind × freshness when no weights supplied", () => {
    const chunk = makeChunk({ rawScore: 1.0, kind: "feature", role: ["all"] });
    const result = scoreChunk(chunk, "implementer");
    expect(result.score).toBeCloseTo(0.9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: scoreChunk with weights that omit chunk.providerId → identity
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreChunk — weights omit providerId (AC2)", () => {
  test("AC2: weights map a different provider → score equals the no-weights score", () => {
    const chunk = makeChunk({ rawScore: 1.0, kind: "feature", providerId: "p1" });
    const without = scoreChunk(chunk, "implementer");
    const withOtherProviderWeight = scoreChunk(chunk, "implementer", undefined, false, {
      someOtherProvider: 0.5,
    });
    // AC2: weights that don't include chunk.providerId must be ignored — score unchanged.
    expect(withOtherProviderWeight.score).toBeCloseTo(without.score);
  });

  test("AC2 (empty map): empty weight object is equivalent to no weights", () => {
    const chunk = makeChunk({ rawScore: 0.8, kind: "rag", providerId: "p1" });
    const without = scoreChunk(chunk, "implementer");
    const withEmpty = scoreChunk(chunk, "implementer", undefined, false, {});
    expect(withEmpty.score).toBeCloseTo(without.score);
  });

  test("AC2 (boundary): chunk without providerId → weights are always ignored", () => {
    // No providerId set on the chunk — even if the weights map names the chunk's
    // synthetic id, the lookup must miss (chunk.providerId is undefined).
    const chunk = makeChunk({ rawScore: 0.7, kind: "rag" });
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
    const chunk = makeChunk({ rawScore: 1.0, kind: "feature", providerId: "p1" });
    const without = scoreChunk(chunk, "implementer");
    const withHalf = scoreChunk(chunk, "implementer", undefined, false, { p1: 0.5 });
    expect(withHalf.score).toBeCloseTo(without.score * 0.5);
  });

  test("AC1 (weight 0.2): score = score-without-weights × 0.2", () => {
    const chunk = makeChunk({ rawScore: 1.0, kind: "feature", providerId: "p1" });
    const without = scoreChunk(chunk, "implementer");
    const withLow = scoreChunk(chunk, "implementer", undefined, false, { p1: 0.2 });
    expect(withLow.score).toBeCloseTo(without.score * 0.2);
  });

  test("AC1 (non-feature kind): weight applied multiplicatively on top of role × kind × freshness", () => {
    const chunk = makeChunk({ rawScore: 1.0, kind: "rag", providerId: "rag-provider" });
    const without = scoreChunk(chunk, "implementer");
    const withHalf = scoreChunk(chunk, "implementer", undefined, false, { "rag-provider": 0.5 });
    // base = 1.0 × 1.0 × 0.7 × 1.0 = 0.7 ; with 0.5 weight → 0.35
    expect(without.score).toBeCloseTo(0.7);
    expect(withHalf.score).toBeCloseTo(without.score * 0.5);
  });

  test("AC1 (weight 1.0): score unchanged when weight is identity", () => {
    const chunk = makeChunk({ rawScore: 0.6, kind: "feature", providerId: "p1" });
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
    const chunkA = makeChunk({
      id: "a:1",
      rawScore: 1.0,
      kind: "feature",
      providerId: "p1",
    });
    const chunkB = makeChunk({
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
    const chunkA = makeChunk({ id: "a:1", rawScore: 1.0, kind: "feature", providerId: "p1" });
    const chunkB = makeChunk({ id: "b:1", rawScore: 1.0, kind: "feature", providerId: "p2" });
    const weights = { p1: 0.5, p2: 1.0 };
    const [scoredA, scoredB] = scoreChunks([chunkA, chunkB], "implementer", undefined, weights);
    expect(scoredA.score).toBeCloseTo(scoredB.score * 0.5);
  });

  test("AC4 (preserves order): scoreChunks returns results in input order regardless of weights", () => {
    const chunkA = makeChunk({ id: "first:1", rawScore: 0.7, kind: "feature", providerId: "p1" });
    const chunkB = makeChunk({ id: "second:1", rawScore: 0.7, kind: "feature", providerId: "p2" });
    const weights = { p1: 0.1, p2: 0.9 };
    const [first, second] = scoreChunks([chunkA, chunkB], "implementer", undefined, weights);
    expect(first.id).toBe("first:1");
    expect(second.id).toBe("second:1");
  });

  test("AC4 (omitted provider): chunk whose providerId is missing from weights gets identity score", () => {
    const chunkA = makeChunk({ id: "a:1", rawScore: 1.0, kind: "feature", providerId: "p1" });
    const chunkB = makeChunk({ id: "b:1", rawScore: 1.0, kind: "feature", providerId: "p2" });
    const weights = { p1: 0.5 }; // p2 omitted
    const withoutWeights = scoreChunks([chunkA, chunkB], "implementer");
    const withWeights = scoreChunks([chunkA, chunkB], "implementer", undefined, weights);
    // chunkB's providerId is omitted → must equal the no-weight score.
    expect(withWeights[1].score).toBeCloseTo(withoutWeights[1].score);
    // chunkA's providerId is keyed → scored at 0.5× the no-weight score.
    expect(withWeights[0].score).toBeCloseTo(withoutWeights[0].score * 0.5);
  });
});
