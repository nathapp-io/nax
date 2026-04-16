import { describe, test, expect } from "bun:test";
import { packChunks } from "../../../../src/context/v2/packing";
import type { ScoredChunk } from "../../../../src/context/v2/scoring";

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
    expect(result.floorItemIds).toContain("rules:1");
    expect(result.packed[0].reason).toBe("budget-exceeded-by-floor");
    expect(result.usedTokens).toBe(5000);
  });

  test("feature chunks always packed even if they exceed budget", () => {
    const chunks = [
      makeScored({ id: "feat:1", kind: "feature", tokens: 3000, score: 1.0 }),
    ];
    const result = packChunks(chunks, 500);
    expect(result.packed[0].id).toBe("feat:1");
    expect(result.floorItemIds).toContain("feat:1");
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
    expect(result.floorItemIds).toHaveLength(0);
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
});
