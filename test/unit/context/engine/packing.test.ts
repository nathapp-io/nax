import { describe, test, expect } from "bun:test";
import { packChunks } from "../../../../src/context/engine/packing";
import type { ScoredChunk } from "../../../../src/context/engine/scoring";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let _idSeq = 0;
function makeScored(overrides: Partial<ScoredChunk> = {}): ScoredChunk {
  _idSeq++;
  return {
    id: `chunk:${_idSeq}`,
    kind: "feature",
    scope: "feature",
    role: ["implementer"],
    content: "content",
    tokens: 100,
    rawScore: 0.8,
    score: 0.8,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// packChunks — greedy behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("packChunks — greedy", () => {
  test("empty input: empty output", () => {
    const result = packChunks([], 1000);
    expect(result.packed).toHaveLength(0);
    expect(result.usedTokens).toBe(0);
  });

  test("chunks within budget: all packed", () => {
    const chunks = [
      makeScored({ tokens: 100 }),
      makeScored({ tokens: 200 }),
      makeScored({ tokens: 300 }),
    ];
    const result = packChunks(chunks, 1000);
    expect(result.packed).toHaveLength(3);
    expect(result.usedTokens).toBe(600);
    expect(result.budgetExcludedIds).toHaveLength(0);
  });

  test("chunks exceed budget: greedy selects by score", () => {
    // Use non-floor kinds so budget exclusion actually applies
    const chunks = [
      makeScored({ id: "low:1", kind: "session", score: 0.5, tokens: 500 }),
      makeScored({ id: "high:1", kind: "session", score: 0.9, tokens: 400 }),
      makeScored({ id: "mid:1", kind: "session", score: 0.7, tokens: 300 }),
    ];
    // Budget 700: high (400) + mid (300) = 700 ✓; low (500) excluded
    const result = packChunks(chunks, 700);
    const packedIds = result.packed.map((c) => c.id);
    expect(packedIds).toContain("high:1");
    expect(packedIds).toContain("mid:1");
    expect(result.budgetExcludedIds).toContain("low:1");
  });

  test("non-floor chunks are ordered by score density (score/tokens), not raw score", () => {
    // "bulky" has higher raw score (0.9) but far lower density (0.9/900 = 0.001)
    // than "dense" (0.5/100 = 0.005). A raw-score sort would pack "bulky" first
    // and exclude "dense"; a density sort does the opposite.
    const chunks = [
      makeScored({ id: "bulky", kind: "session", score: 0.9, tokens: 900 }),
      makeScored({ id: "dense", kind: "session", score: 0.5, tokens: 100 }),
    ];
    const result = packChunks(chunks, 900);
    expect(result.packed.map((c) => c.id)).toEqual(["dense"]);
    expect(result.budgetExcludedIds).toContain("bulky");
  });

  test("a zero-token chunk does not produce NaN/Infinity that breaks the sort", () => {
    const chunks = [
      makeScored({ id: "free", kind: "session", score: 0.1, tokens: 0 }),
      makeScored({ id: "normal", kind: "session", score: 0.9, tokens: 100 }),
    ];
    const result = packChunks(chunks, 100);
    const packedIds = result.packed.map((c) => c.id);
    // Zero-token chunk is free to include and should not exclude "normal".
    expect(packedIds).toContain("free");
    expect(packedIds).toContain("normal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget floor rule
// ─────────────────────────────────────────────────────────────────────────────

describe("packChunks — budget floor", () => {
  test("static chunks always packed even if they exceed budget", () => {
    const chunks = [
      makeScored({ id: "rules:1", kind: "static", tokens: 5000, score: 1.0 }),
    ];
    const result = packChunks(chunks, 100);  // budget << chunk size
    expect(result.packed).toHaveLength(1);
    expect(result.packed[0].id).toBe("rules:1");
    expect(result.floorPackedIds).toContain("rules:1");
    expect(result.floorOverageIds).toContain("rules:1");
    expect(result.packed[0].reason).toBe("budget-exceeded-by-floor");
    expect(result.usedTokens).toBe(5000);
  });

  test("feature chunks always packed even if they exceed budget", () => {
    const chunks = [
      makeScored({ id: "feat:1", kind: "feature", tokens: 3000, score: 1.0 }),
    ];
    const result = packChunks(chunks, 500);
    expect(result.packed[0].id).toBe("feat:1");
    expect(result.floorPackedIds).toContain("feat:1");
    expect(result.floorOverageIds).toContain("feat:1");
  });

  test("floor items packed first, then non-floor fills remaining budget", () => {
    const chunks = [
      makeScored({ id: "rules:1", kind: "static", tokens: 300, score: 1.0 }),
      makeScored({ id: "feat:1", kind: "feature", tokens: 300, score: 1.0 }),
      makeScored({ id: "sess:1", kind: "session", tokens: 300, score: 0.9 }),
      makeScored({ id: "hist:1", kind: "history", tokens: 500, score: 0.5 }),
    ];
    // Budget 1000: floor=600, remaining=400 → session (300) fits, history (500) does not
    const result = packChunks(chunks, 1000);
    const packedIds = result.packed.map((c) => c.id);
    expect(packedIds).toContain("rules:1");
    expect(packedIds).toContain("feat:1");
    expect(packedIds).toContain("sess:1");
    expect(result.budgetExcludedIds).toContain("hist:1");
    expect(result.usedTokens).toBe(900);
  });

  test("floor items without overflow have no reason set", () => {
    const chunks = [
      makeScored({ id: "rules:1", kind: "static", tokens: 100, score: 1.0 }),
    ];
    const result = packChunks(chunks, 1000);
    expect(result.packed[0].reason).toBeUndefined();
    expect(result.floorPackedIds).toContain("rules:1");
    expect(result.floorOverageIds).toHaveLength(0);
  });

  test("test-coverage chunks are floor-included even when score is below minScore", () => {
    const chunks = [
      makeScored({ id: "tc:1", kind: "test-coverage", tokens: 300, score: 0.05, belowMinScore: true }),
    ];
    const result = packChunks(chunks, 100);
    expect(result.packed).toHaveLength(1);
    expect(result.packed[0].id).toBe("tc:1");
    expect(result.floorPackedIds).toContain("tc:1");
    expect(result.floorOverageIds).toContain("tc:1");
    expect(result.packed[0].reason).toBe("budget-exceeded-by-floor");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// availableBudgetTokens — effective ceiling
// ─────────────────────────────────────────────────────────────────────────────

describe("packChunks — availableBudgetTokens", () => {
  test("uses min(budgetTokens, availableBudgetTokens) as ceiling", () => {
    const chunks = [
      makeScored({ id: "a:1", kind: "session", tokens: 400, score: 0.9 }),
      makeScored({ id: "b:1", kind: "session", tokens: 400, score: 0.8 }),
    ];
    // budgetTokens=1000, available=500 → effective=500
    const result = packChunks(chunks, 1000, 500);
    expect(result.effectiveBudget).toBe(500);
    const packedIds = result.packed.map((c) => c.id);
    expect(packedIds).toContain("a:1");
    expect(result.budgetExcludedIds).toContain("b:1");
  });

  test("when available > budget, budget wins", () => {
    const result = packChunks([], 500, 2000);
    expect(result.effectiveBudget).toBe(500);
  });

  test("availableBudgetTokens=0 packs every floor chunk and no non-floor chunks", () => {
    const chunks = [
      makeScored({ id: "rules:1", kind: "static", tokens: 200, score: 1.0 }),
      makeScored({ id: "feat:1", kind: "feature", tokens: 300, score: 1.0 }),
      makeScored({ id: "tc:1", kind: "test-coverage", tokens: 150, score: 1.0 }),
      makeScored({ id: "sess:1", kind: "session", tokens: 100, score: 0.9 }),
      makeScored({ id: "hist:1", kind: "history", tokens: 400, score: 0.8 }),
    ];
    const result = packChunks(chunks, 5000, 0);
    const packedIds = result.packed.map((c) => c.id);
    // Every floor-kind chunk is packed even when ceiling is 0.
    expect(packedIds).toContain("rules:1");
    expect(packedIds).toContain("feat:1");
    expect(packedIds).toContain("tc:1");
    // Non-floor chunks are dropped.
    expect(packedIds).not.toContain("sess:1");
    expect(packedIds).not.toContain("hist:1");
    // Floor items are all marked as overage (since 0 ceiling < their tokens).
    expect(result.floorOverageIds).toEqual(expect.arrayContaining(["rules:1", "feat:1", "tc:1"]));
    expect(result.budgetExcludedIds).toEqual(expect.arrayContaining(["sess:1", "hist:1"]));
  });

  test("availableBudgetTokens=undefined uses budgetTokens as ceiling and packs the same as a single-arg call", () => {
    const chunks = [
      makeScored({ id: "rules:1", kind: "static", tokens: 200, score: 1.0 }),
      makeScored({ id: "feat:1", kind: "feature", tokens: 200, score: 1.0 }),
      makeScored({ id: "sess:1", kind: "session", tokens: 200, score: 0.9 }),
      makeScored({ id: "hist:1", kind: "history", tokens: 500, score: 0.8 }),
    ];
    const budget = 700;
    const withOmitted = packChunks(chunks, budget);
    const withUndefined = packChunks(chunks, budget, undefined);
    // effectiveBudget equals budgetTokens when availableBudgetTokens is omitted.
    expect(withOmitted.effectiveBudget).toBe(budget);
    expect(withUndefined.effectiveBudget).toBe(budget);
    // Packed set is identical to the single-arg form.
    expect(withUndefined.packed.map((c) => c.id)).toEqual(withOmitted.packed.map((c) => c.id));
    expect(withUndefined.budgetExcludedIds.sort()).toEqual(withOmitted.budgetExcludedIds.sort());
  });
});
