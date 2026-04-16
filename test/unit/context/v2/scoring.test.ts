import { describe, test, expect } from "bun:test";
import { scoreChunk, scoreChunks, MIN_SCORE } from "../../../../src/context/v2/scoring";
import type { RawChunk } from "../../../../src/context/v2/types";

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
