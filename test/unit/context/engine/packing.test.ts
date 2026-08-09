import { describe, expect, test } from "bun:test";
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
    const chunks = [makeScored({ tokens: 100 }), makeScored({ tokens: 200 }), makeScored({ tokens: 300 })];
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

  test("non-floor chunks are ordered by score density (score/tokens), not raw score (US-004)", () => {
    // Two 100-token chunks scoring 0.5 each (jointly 1.0) sit against one
    // 900-token chunk scoring 0.9 (raw-score winner) at budget 900. Density
    // packs both small chunks (1.0 score); raw-score packs only the bulky one
    // (0.9 score). The repair (best-of greedy / largest single item) does NOT
    // beat the greedy result here because the largest single item is the
    // bulky chunk at 0.9 — strictly less than the greedy 1.0.
    const chunks = [
      makeScored({ id: "bulky", kind: "session", score: 0.9, tokens: 900 }),
      makeScored({ id: "small:a", kind: "session", score: 0.5, tokens: 100 }),
      makeScored({ id: "small:b", kind: "session", score: 0.5, tokens: 100 }),
    ];
    const result = packChunks(chunks, 900);
    const packedIds = result.packed.map((c) => c.id);
    expect(packedIds).toContain("small:a");
    expect(packedIds).toContain("small:b");
    expect(packedIds).not.toContain("bulky");
    expect(result.budgetExcludedIds).toContain("bulky");
  });

  test("AC-1: repair selects the bulky high-score chunk when density-greedy would miss it", () => {
    // 900-token (0.9) + 100-token (0.5) at budget 900. Density-greedy packs
    // only the 100-token chunk (score 0.5); the 900-token chunk alone scores
    // 0.9, which beats the greedy 0.5 — the repair must pick the bulky one.
    const chunks = [
      makeScored({ id: "bulky", kind: "session", score: 0.9, tokens: 900 }),
      makeScored({ id: "small", kind: "session", score: 0.5, tokens: 100 }),
    ];
    const result = packChunks(chunks, 900);
    expect(result.packed.map((c) => c.id)).toEqual(["bulky"]);
    expect(result.budgetExcludedIds).toContain("small");
  });

  test("regression: (6,1.0)/(5,0.8)/(5,0.8) at budget 10 — best-pair repair beats density-greedy", () => {
    // Three non-floor chunks:
    //   a: tokens=6, score=1.0   → density 0.167
    //   b: tokens=5, score=0.8   → density 0.16
    //   c: tokens=5, score=0.8   → density 0.16
    // At budget 10, density-greedy packs only a (6 tokens, 1.0 score).
    // Largest single item is also a (1.0). Best pair is b + c (10 tokens,
    // 1.6 score), which beats greedy — the repair selects b + c.
    const chunks = [
      makeScored({ id: "a", kind: "session", score: 1.0, tokens: 6 }),
      makeScored({ id: "b", kind: "session", score: 0.8, tokens: 5 }),
      makeScored({ id: "c", kind: "session", score: 0.8, tokens: 5 }),
    ];
    const result = packChunks(chunks, 10);
    const packedScore = result.packed.reduce((s, c) => s + c.score, 0);
    const optimal = 1.6; // b + c: 10 tokens, 1.6 score
    expect(result.packed.map((c) => c.id)).toEqual(["b", "c"]);
    expect(result.budgetExcludedIds).toEqual(["a"]);
    expect(packedScore).toBe(1.6);
    expect(packedScore / optimal).toBeGreaterThanOrEqual(0.95);
  });

  test("AC-3: when every input chunk is non-floor, usedTokens does not exceed effectiveBudget", () => {
    const chunks = [
      makeScored({ id: "a:1", kind: "session", tokens: 200, score: 0.9 }),
      makeScored({ id: "b:1", kind: "history", tokens: 300, score: 0.7 }),
      makeScored({ id: "c:1", kind: "neighbor", tokens: 250, score: 0.5 }),
    ];
    const result = packChunks(chunks, 900);
    expect(result.usedTokens).toBeLessThanOrEqual(result.effectiveBudget);
    expect(result.usedTokens).toBeLessThanOrEqual(900);
    expect(Number.isFinite(result.usedTokens)).toBe(true);
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
    expect(Number.isFinite(result.usedTokens)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: deterministic 95%-of-optimal property test
// ─────────────────────────────────────────────────────────────────────────────

// Mulberry32 — small, deterministic PRNG seeded by a fixed value so failures
// are reproducible. Platform Math.random() is forbidden here.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("packChunks — AC-4 optimality property", () => {
  test("at least 200 fixed-seed cases are within 95% of exhaustive 0/1 optimum", () => {
    const SEED = 0x5e2d_4c01;
    const NUM_CASES = 200;
    const MAX_CHUNKS = 12;
    const TOKEN_MIN = 1;
    const TOKEN_MAX = 10;
    const BUDGET_MIN = 60;
    const BUDGET_MAX = 199;
    const rng = mulberry32(SEED);

    let worstRatio = 1;
    let worstCase: { case: number; packed: number; optimal: number } | null = null;

    // ── Fixed regression: (6,1.0)+(5,0.8)+(5,0.8) at budget 10 ──────────
    // Included as a fixed case within the 200-case 95%-threshold evaluation.
    // The best-pair repair correctly selects b + c for 1.6 against optimum
    // 1.6 (ratio 1.0), validating the per-case AC-4 guarantee.
    const REGRESSION_CASE = {
      chunks: [
        makeScored({ id: "a-reg", kind: "session", score: 1.0, tokens: 6 }),
        makeScored({ id: "b-reg", kind: "session", score: 0.8, tokens: 5 }),
        makeScored({ id: "c-reg", kind: "session", score: 0.8, tokens: 5 }),
      ] as ScoredChunk[],
      budget: 10,
    };
    {
      const result = packChunks(REGRESSION_CASE.chunks, REGRESSION_CASE.budget);
      const packedScore = (result.packed as ScoredChunk[]).reduce((s, c) => s + c.score, 0);
      let optimal = 0;
      for (let mask = 0; mask < (1 << 3); mask++) {
        let tokens = 0;
        let score = 0;
        for (let i = 0; i < 3; i++) {
          if (mask & (1 << i)) {
            tokens += REGRESSION_CASE.chunks[i].tokens;
            if (tokens > REGRESSION_CASE.budget) break;
            score += REGRESSION_CASE.chunks[i].score;
          }
        }
        if (tokens <= REGRESSION_CASE.budget && score > optimal) optimal = score;
      }
      const ratio = optimal <= 0 ? 1 : packedScore / optimal;
      expect(ratio).toBeGreaterThanOrEqual(0.95);
    }

    // The 200 cases mix two distributions on purpose:
    //   adversarial (first 100): multi-item capacity conflicts built so
    //     greedy-by-density excludes the bulky high-score chunk in favour of
    //     many small items that jointly fill the budget. The repair flips to
    //     the bulky chunk and recovers the optimum. This is the case the
    //     repair exists to handle, and exercises greedy-vs-repair selection
    //     across the full n <= 12 space (not just the 2-item AC-1 fixture).
    //     Construction: nAdv >= 2; smallTokens * (nAdv-1) > budget so greedy
    //     packs all smalls; bulkyTokens > budget - smallTokens so no small
    //     fits alongside bulky, making the bulky the unique optimum.
    //   random (last 100): independent random tokens/scores at the easy end
    //     of the spec's range (tokens 1..10, budget 60..199) where greedy
    //     by density already hits the optimum or close to it.
    const ADV_COUNT = 100;

    for (let caseIdx = 0; caseIdx < NUM_CASES; caseIdx++) {
      const chunks: ScoredChunk[] = [];
      let budget: number;

      if (caseIdx < ADV_COUNT) {
        // Adversarial: 1 bulky + (nAdv-1) small items. Enforce nAdv >= 2 and
        // (nAdv-1) * smallTokens > budget so the capacity conflict actually exists.
        const nAdv = 2 + Math.floor(rng() * (MAX_CHUNKS - 1)); // 2..12
        const smallTokens = 10 + Math.floor(rng() * 11); // 10..20
        // Budget ceiling: must be < (nAdv-1)*smallTokens so smalls collectively
        // overflow. Budget floor: must be >= smallTokens+1 so bulky is feasible.
        const budgetLo = Math.max(BUDGET_MIN, smallTokens + 1);
        const budgetHi = Math.min(BUDGET_MAX, (nAdv - 1) * smallTokens - 1);
        if (budgetLo <= budgetHi) {
          budget = budgetLo + Math.floor(rng() * (budgetHi - budgetLo + 1));
          const minBulkyTokens = budget - smallTokens + 1;
          const bulkyTokens = minBulkyTokens + Math.floor(rng() * (budget - minBulkyTokens + 1));
          const bulkyScore = 0.9 + rng() * 0.05; // 0.9..0.95
          chunks.push(
            makeScored({
              id: `b-${caseIdx}`,
              kind: "session",
              score: Math.round(bulkyScore * 1000) / 1000,
              tokens: bulkyTokens,
            }),
          );
          for (let i = 0; i < nAdv - 1; i++) {
            const smallScore = 0.1 + rng() * 0.05; // 0.1..0.15
            chunks.push(
              makeScored({
                id: `f-${caseIdx}-${i}`,
                kind: "session",
                score: Math.round(smallScore * 1000) / 1000,
                tokens: smallTokens,
              }),
            );
          }
        } else {
          // Cannot construct — fall back to random.
          budget = BUDGET_MIN + Math.floor(rng() * (BUDGET_MAX - BUDGET_MIN + 1));
          const n = 1 + Math.floor(rng() * MAX_CHUNKS);
          for (let i = 0; i < n; i++) {
            const tokens = TOKEN_MIN + Math.floor(rng() * (TOKEN_MAX - TOKEN_MIN + 1));
            const score = 0.05 + rng() * 0.95;
            chunks.push(
              makeScored({
                id: `c-${caseIdx}-${i}`,
                kind: "session",
                score: Math.round(score * 1000) / 1000,
                tokens,
              }),
            );
          }
        }
      } else {
        budget = BUDGET_MIN + Math.floor(rng() * (BUDGET_MAX - BUDGET_MIN + 1));
        const n = 1 + Math.floor(rng() * MAX_CHUNKS);
        for (let i = 0; i < n; i++) {
          const tokens = TOKEN_MIN + Math.floor(rng() * (TOKEN_MAX - TOKEN_MIN + 1)); // 1..10
          const score = 0.05 + rng() * 0.95; // 0.05..1.0
          chunks.push(
            makeScored({
              id: `c-${caseIdx}-${i}`,
              kind: "session",
              score: Math.round(score * 1000) / 1000,
              tokens,
            }),
          );
        }
      }

      const result = packChunks(chunks, budget);
      const packedScore = (result.packed as ScoredChunk[]).reduce((s, c) => s + c.score, 0);

      // Exhaustive 0/1 knapsack: enumerate every subset of non-floor chunks.
      let optimal = 0;
      const totalSubsets = 1 << chunks.length;
      for (let mask = 0; mask < totalSubsets; mask++) {
        let tokens = 0;
        let score = 0;
        for (let i = 0; i < chunks.length; i++) {
          if (mask & (1 << i)) {
            tokens += chunks[i].tokens;
            if (tokens > budget) break;
            score += chunks[i].score;
          }
        }
        if (tokens <= budget && score > optimal) optimal = score;
      }

      const ratio = optimal <= 0 ? 1 : packedScore / optimal;
      if (ratio < worstRatio) {
        worstRatio = ratio;
        worstCase = { case: caseIdx, packed: packedScore, optimal };
      }
    }

    expect(worstRatio).toBeGreaterThanOrEqual(0.95);
    if (worstRatio < 0.95 && worstCase) {
      throw new Error(
        `worst case ${worstCase.case}: packed=${worstCase.packed.toFixed(3)} optimal=${worstCase.optimal.toFixed(3)} ratio=${worstRatio.toFixed(3)}`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget floor rule
// ─────────────────────────────────────────────────────────────────────────────

describe("packChunks — budget floor", () => {
  test("static chunks always packed even if they exceed budget", () => {
    const chunks = [makeScored({ id: "rules:1", kind: "static", tokens: 5000, score: 1.0 })];
    const result = packChunks(chunks, 100); // budget << chunk size
    expect(result.packed).toHaveLength(1);
    expect(result.packed[0].id).toBe("rules:1");
    expect(result.floorPackedIds).toContain("rules:1");
    expect(result.floorOverageIds).toContain("rules:1");
    expect(result.packed[0].reason).toBe("budget-exceeded-by-floor");
    expect(result.usedTokens).toBe(5000);
  });

  test("feature chunks always packed even if they exceed budget", () => {
    const chunks = [makeScored({ id: "feat:1", kind: "feature", tokens: 3000, score: 1.0 })];
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
    const chunks = [makeScored({ id: "rules:1", kind: "static", tokens: 100, score: 1.0 })];
    const result = packChunks(chunks, 1000);
    expect(result.packed[0].reason).toBeUndefined();
    expect(result.floorPackedIds).toContain("rules:1");
    expect(result.floorOverageIds).toHaveLength(0);
  });

  test("test-coverage chunks are floor-included even when score is below minScore", () => {
    const chunks = [makeScored({ id: "tc:1", kind: "test-coverage", tokens: 300, score: 0.05, belowMinScore: true })];
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
