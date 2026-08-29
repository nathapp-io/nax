/**
 * provider-weights.ts — US-003 deriveProviderWeights tests
 *
 * Covers AC6–AC14 of US-003. `deriveProviderWeights(manifests)` is a pure
 * function — no I/O, no clock, no logger — and its contract is pinned
 * entirely by the AC list:
 *
 *   AC6:  empty input → 1.0 for any queried provider
 *   AC7:  below observation gate → 1.0
 *   AC8:  clears observation count with no ignored → 1.0
 *   AC9:  monotone non-increasing w.r.t. ignored ratio
 *   AC10: no weight > 1.0
 *   AC11: every classified chunk ignored → weight > 0
 *   AC12: chunkEffectiveness present but chunkProviders absent → 1.0 for every provider
 *   AC13: malformed manifest → derive from remaining well-formed manifests
 *   AC14: only ignored verdicts for FLOOR_KINDS providers → weights still returned
 *
 * Constants (`k`, `MIN_WEIGHT`, `MIN_OBSERVATIONS`) are deliberately not
 * pinned — they are not knowable at authoring time. The tests assert on
 * properties the ACs pin (monotone, bounded, identity below gate, etc.).
 *
 * The current stub throws "not implemented"; every test below therefore
 * fails at runtime (assertion failure), proving the behaviour is missing.
 */

import { describe, expect, test } from "bun:test";
import { deriveProviderWeights } from "@/context/engine";
import type { ChunkEffectiveness, ContextManifest } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ChunkVerdict {
  chunkId: string;
  providerId: string;
  /** Chunk kind for FLOOR_KINDS-aware tests */
  kind: "static" | "feature" | "test-coverage" | "history" | "neighbor" | "rag" | "graph" | "kb" | "session";
  signal: "ignored" | "followed" | "contradicted" | "unknown";
}

interface ManifestSpec {
  /** chunkProviders entries: chunkId → providerId */
  chunkProviders?: Record<string, string>;
  /** chunkEffectiveness entries: chunkId → signal */
  chunkEffectiveness?: Record<string, ChunkEffectiveness>;
  /** kinds for each chunk — needed only for FLOOR_KINDS coverage */
  chunkKinds?: Record<string, ChunkVerdict["kind"]>;
  /** Include the field at all? Default true; set false to omit. */
  includeProviders?: boolean;
  includeEffectiveness?: boolean;
}

function buildManifest(spec: ManifestSpec = {}): ContextManifest {
  const includeProviders = spec.includeProviders ?? true;
  const includeEffectiveness = spec.includeEffectiveness ?? true;
  const manifest: ContextManifest = {
    requestId: "req-1",
    stage: "execution",
    totalBudgetTokens: 8_000,
    usedTokens: 100,
    includedChunks: Object.keys(spec.chunkProviders ?? spec.chunkEffectiveness ?? {}),
    excludedChunks: [],
    floorItems: [],
    digestTokens: 12,
    buildMs: 5,
  };
  if (includeProviders && spec.chunkProviders !== undefined) {
    manifest.chunkProviders = spec.chunkProviders;
  }
  if (includeEffectiveness && spec.chunkEffectiveness !== undefined) {
    manifest.chunkEffectiveness = spec.chunkEffectiveness;
  }
  return manifest;
}

function ignoredManifest(verdicts: ChunkVerdict[]): ContextManifest {
  const chunkProviders: Record<string, string> = {};
  const chunkEffectiveness: Record<string, ChunkEffectiveness> = {};
  for (const v of verdicts) {
    chunkProviders[v.chunkId] = v.providerId;
    chunkEffectiveness[v.chunkId] = { signal: v.signal };
  }
  return buildManifest({ chunkProviders, chunkEffectiveness });
}

function ignoredChunk(id: string, providerId: string, kind: ChunkVerdict["kind"] = "static"): ChunkVerdict {
  return { chunkId: id, providerId, kind, signal: "ignored" };
}

function followedChunk(id: string, providerId: string, kind: ChunkVerdict["kind"] = "static"): ChunkVerdict {
  return { chunkId: id, providerId, kind, signal: "followed" };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC6: empty manifest list → 1.0 for any queried provider
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProviderWeights — empty input (AC6)", () => {
  test("AC6: empty manifest list → 1.0 for any queried provider ID", () => {
    const weights = deriveProviderWeights([]);
    expect(weights["any-provider-id"]).toBe(1.0);
  });

  test("AC6 (multiple lookups): every provider query returns 1.0", () => {
    const weights = deriveProviderWeights([]);
    for (const id of ["static-rules", "git-history", "code-neighbor", "feature-context", "session-scratch"]) {
      expect(weights[id]).toBe(1.0);
    }
  });

  test("AC6 (empty string lookup): empty-string provider ID also returns 1.0", () => {
    // The empty key is harmless — any string lookup must return 1.0.
    const weights = deriveProviderWeights([]);
    expect(weights[""]).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: below observation count → 1.0
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProviderWeights — below observation count (AC7)", () => {
  test("AC7: a provider with one classified chunk yields weight 1.0", () => {
    const manifest = ignoredManifest([ignoredChunk("c1", "static-rules")]);
    const weights = deriveProviderWeights([manifest]);
    expect(weights["static-rules"]).toBe(1.0);
  });

  test("AC7: a provider whose classified chunks are all 'followed' yields weight 1.0", () => {
    // Verdict is 'followed', but the chunk count is below the gate; the
    // gate test runs before the verdict test, so identity wins regardless.
    const manifest = ignoredManifest([followedChunk("c1", "static-rules")]);
    const weights = deriveProviderWeights([manifest]);
    expect(weights["static-rules"]).toBe(1.0);
  });

  test("AC7 (multiple manifests): same provider across manifests still below gate → 1.0", () => {
    const m1 = ignoredManifest([ignoredChunk("c1", "static-rules")]);
    const m2 = ignoredManifest([ignoredChunk("c2", "static-rules")]);
    const weights = deriveProviderWeights([m1, m2]);
    expect(weights["static-rules"]).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: clears observation count with no ignored → 1.0
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProviderWeights — clears observation count, no ignored (AC8)", () => {
  test("AC8: provider with only 'followed' verdicts at-or-above gate yields 1.0", () => {
    // Build a manifest whose every chunk clears the observation gate for
    // static-rules and is 'followed'. The ratio is 0/8 → weight 1.0.
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 16; i++) verdicts.push(followedChunk(`c${i}`, "static-rules"));
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["static-rules"]).toBe(1.0);
  });

  test("AC8: provider with mixed followed/unknown verdicts (no ignored) at-or-above gate yields 1.0", () => {
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(followedChunk(`f${i}`, "static-rules"));
    for (let i = 0; i < 8; i++) {
      verdicts.push({ chunkId: `u${i}`, providerId: "static-rules", kind: "static", signal: "unknown" });
    }
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["static-rules"]).toBe(1.0);
  });

  test("AC8 (boundary): contradicted verdicts also do not contribute to the ignored ratio", () => {
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) {
      verdicts.push({
        chunkId: `x${i}`,
        providerId: "static-rules",
        kind: "static",
        signal: "contradicted",
      });
    }
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["static-rules"]).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: monotone non-increasing w.r.t. ignored ratio
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProviderWeights — monotone non-increasing (AC9)", () => {
  test("AC9: provider A with higher ignored ratio than B yields weight(A) ≤ weight(B)", () => {
    // Build a manifest where static-rules has 5/8 ignored (ratio 0.625) and
    // git-history has 1/8 ignored (ratio 0.125). The higher-ratio provider
    // (static-rules) must NOT score higher than the lower-ratio one.
    const verdicts: ChunkVerdict[] = [];
    // 5 ignored for static-rules
    for (let i = 0; i < 5; i++) verdicts.push(ignoredChunk(`s-ig-${i}`, "static-rules"));
    // 3 followed for static-rules (5 ignored out of 8 total → ratio 0.625)
    for (let i = 0; i < 3; i++) verdicts.push(followedChunk(`s-fo-${i}`, "static-rules"));
    // 1 ignored for git-history (ratio 1/8 = 0.125)
    verdicts.push(ignoredChunk("h-ig-0", "git-history"));
    // 7 followed for git-history
    for (let i = 0; i < 7; i++) verdicts.push(followedChunk(`h-fo-${i}`, "git-history"));

    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    const wA = weights["static-rules"];
    const wB = weights["git-history"];

    // Higher ignored ratio → weight must NOT be strictly greater.
    expect(wA).toBeLessThanOrEqual(wB);
  });

  test("AC9 (multi-manifest): aggregation across multiple manifests preserves monotonicity", () => {
    // Provider A in manifest 1, provider B in manifest 2.
    const m1Verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 6; i++) m1Verdicts.push(ignoredChunk(`a-ig-${i}`, "static-rules"));
    for (let i = 0; i < 2; i++) m1Verdicts.push(followedChunk(`a-fo-${i}`, "static-rules"));

    const m2Verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 1; i++) m2Verdicts.push(ignoredChunk(`b-ig-${i}`, "git-history"));
    for (let i = 0; i < 7; i++) m2Verdicts.push(followedChunk(`b-fo-${i}`, "git-history"));

    const weights = deriveProviderWeights([ignoredManifest(m1Verdicts), ignoredManifest(m2Verdicts)]);
    const wA = weights["static-rules"];
    const wB = weights["git-history"];
    expect(wA).toBeLessThanOrEqual(wB);
  });

  test("AC9 (zero-vs-non-zero): a provider with 0 ignored wins over one with >0 ignored", () => {
    // Provider A: 8/8 ignored (ratio 1.0). Provider B: 0/8 ignored (ratio 0.0).
    // Weight(A) ≤ weight(B) must hold. With B at the gate boundary, B is
    // identity (1.0), so A must be ≤ 1.0 (AC10 also pins this).
    const verdictsA: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdictsA.push(ignoredChunk(`a-${i}`, "static-rules"));

    const verdictsB: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdictsB.push(followedChunk(`b-${i}`, "git-history"));

    const weights = deriveProviderWeights([ignoredManifest(verdictsA), ignoredManifest(verdictsB)]);
    const wA = weights["static-rules"];
    const wB = weights["git-history"];
    expect(wA).toBeLessThanOrEqual(wB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: no weight > 1.0
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProviderWeights — bounded above by 1.0 (AC10)", () => {
  test("AC10: no returned weight is greater than 1.0 across a mixed-input manifest set", () => {
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(followedChunk(`f-${i}`, "static-rules"));
    // Add some ignored for several providers.
    for (const providerId of ["git-history", "code-neighbor", "feature-context"]) {
      for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`${providerId}-${i}`, providerId));
    }

    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    for (const [_providerId, w] of Object.entries(weights)) {
      expect(w).toBeLessThanOrEqual(1.0);
    }
    // And specifically the providers above
    expect(weights["static-rules"]).toBeLessThanOrEqual(1.0);
    expect(weights["git-history"]).toBeLessThanOrEqual(1.0);
    expect(weights["code-neighbor"]).toBeLessThanOrEqual(1.0);
    expect(weights["feature-context"]).toBeLessThanOrEqual(1.0);
  });

  test("AC10 (all-ignored): even when every chunk for a provider is ignored, weight ≤ 1.0", () => {
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`x-${i}`, "static-rules"));
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["static-rules"]).toBeLessThanOrEqual(1.0);
  });

  test("AC10 (boundary): an empty input also yields 1.0 — covered by AC6", () => {
    const weights = deriveProviderWeights([]);
    expect(weights.x).toBeLessThanOrEqual(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11: every classified chunk for a provider is ignored → weight > 0
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProviderWeights — weight > 0 (AC11)", () => {
  test("AC11: provider whose every classified chunk is 'ignored' has weight > 0", () => {
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`ig-${i}`, "static-rules"));
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["static-rules"]).toBeGreaterThan(0);
  });

  test("AC11 (large ignored set): even 100 ignored chunks yield weight > 0", () => {
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 100; i++) verdicts.push(ignoredChunk(`ig-${i}`, "static-rules"));
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["static-rules"]).toBeGreaterThan(0);
  });

  test("AC11 (mixed providers): the all-ignored provider's weight is still > 0", () => {
    const verdicts: ChunkVerdict[] = [];
    // static-rules: all ignored
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`s-${i}`, "static-rules"));
    // git-history: all followed (control)
    for (let i = 0; i < 8; i++) verdicts.push(followedChunk(`h-${i}`, "git-history"));

    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["static-rules"]).toBeGreaterThan(0);
    // git-history should be 1.0 — both bounded-above and identity for zero ignored.
    expect(weights["git-history"]).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12: chunkEffectiveness but no chunkProviders → 1.0 for every queried ID
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProviderWeights — chunkProviders absent (AC12)", () => {
  test("AC12: manifest with chunkEffectiveness but no chunkProviders → every queried provider returns 1.0", () => {
    // The manifest has verdicts but no provider attribution — we cannot
    // group them, so the function must return 1.0 for any provider we ask.
    const manifest: ContextManifest = {
      requestId: "r1",
      stage: "execution",
      totalBudgetTokens: 8_000,
      usedTokens: 100,
      includedChunks: ["c1", "c2", "c3"],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 12,
      buildMs: 5,
      chunkEffectiveness: {
        c1: { signal: "ignored" },
        c2: { signal: "ignored" },
        c3: { signal: "ignored" },
      },
      // intentionally no chunkProviders
    };

    const weights = deriveProviderWeights([manifest]);
    for (const id of ["static-rules", "git-history", "code-neighbor", "feature-context", "any-id"]) {
      expect(weights[id]).toBe(1.0);
    }
  });

  test("AC12 (all-ignored verdicts, no providers): the absence of chunkProviders still yields 1.0", () => {
    const verdicts = Array.from({ length: 16 }, (_, i) => ({
      chunkId: `c${i}`,
      providerId: "static-rules", // would be ignored if present
      kind: "static" as const,
      signal: "ignored" as const,
    }));
    const manifest: ContextManifest = {
      requestId: "r2",
      stage: "execution",
      totalBudgetTokens: 8_000,
      usedTokens: 100,
      includedChunks: verdicts.map((v) => v.chunkId),
      excludedChunks: [],
      floorItems: [],
      digestTokens: 12,
      buildMs: 5,
      chunkEffectiveness: Object.fromEntries(verdicts.map((v) => [v.chunkId, { signal: v.signal }])),
      // chunkProviders intentionally absent
    };

    const weights = deriveProviderWeights([manifest]);
    expect(weights["static-rules"]).toBe(1.0);
  });

  test("AC12 (partial providers): only chunks whose chunkProviders maps them contribute; the rest are skipped", () => {
    // Two chunks: c1 is attributed to static-rules and ignored; c2 is ignored
    // but un-attributed. The un-attributed chunk is silently skipped — only
    // the attributed one contributes.
    const manifest: ContextManifest = {
      requestId: "r3",
      stage: "execution",
      totalBudgetTokens: 8_000,
      usedTokens: 100,
      includedChunks: ["c1", "c2"],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 12,
      buildMs: 5,
      chunkProviders: { c1: "static-rules" },
      chunkEffectiveness: {
        c1: { signal: "ignored" },
        c2: { signal: "ignored" },
      },
    };

    const weights = deriveProviderWeights([manifest]);
    // c1 alone is one ignored chunk for static-rules — below the gate — so
    // the result must be identity (1.0) per AC7.
    expect(weights["static-rules"]).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13: malformed manifest → derive from remaining well-formed manifests
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProviderWeights — malformed input (AC13)", () => {
  test("AC13: a malformed manifest in the input list does not cause throw; remaining manifests drive the result", () => {
    // A manifest object that does not satisfy ContextManifest shape — e.g.
    // missing required fields, or containing bogus types. The function
    // must swallow it (best-effort) and proceed.
    const malformed = {
      // missing required fields (requestId, stage, etc.)
      bogus: "garbage",
    } as unknown as ContextManifest; // test-ratchet-allow: as-unknown-as

    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`ig-${i}`, "static-rules"));

    let threw = false;
    let weights: Record<string, number> = {};
    try {
      weights = deriveProviderWeights([malformed, ignoredManifest(verdicts)]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // The well-formed manifest should still drive the result.
    expect(weights["static-rules"]).toBeGreaterThan(0);
  });

  test("AC13 (all-malformed input): every manifest malformed → empty/identity mapping, no throw", () => {
    const malformed1 = { missing: "fields" } as unknown as ContextManifest; // test-ratchet-allow: as-unknown-as
    const malformed2 = null as unknown as ContextManifest; // test-ratchet-allow: as-unknown-as

    let threw = false;
    let weights: Record<string, number> = {};
    try {
      weights = deriveProviderWeights([malformed1, malformed2]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Identity behavior on full-malformed input — 1.0 for any queried id.
    expect(weights["any-provider"]).toBe(1.0);
  });

  test("AC13 (boundary): a manifest missing chunkProviders is NOT malformed — it falls under AC12 identity behavior", () => {
    const manifest: ContextManifest = {
      requestId: "r1",
      stage: "execution",
      totalBudgetTokens: 8_000,
      usedTokens: 100,
      includedChunks: ["c1"],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 12,
      buildMs: 5,
      chunkEffectiveness: { c1: { signal: "ignored" } },
      // chunkProviders absent — well-formed, drives AC12 identity.
    };
    const weights = deriveProviderWeights([manifest]);
    expect(weights["static-rules"]).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC14: FLOOR_KINDS providers still get weights
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProviderWeights — FLOOR_KINDS providers (AC14)", () => {
  test("AC14: ignored verdicts for static-kind chunks still produce a weight for that provider", () => {
    // The chunk kind does not gate the derivation — every mapped chunk with
    // an `ignored` verdict contributes, regardless of whether its provider
    // is floor-eligible.
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`s-${i}`, "static-rules", "static"));
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["static-rules"]).toBeDefined();
    // It is a real weight (above 0, at-or-below 1.0), not omitted.
    expect(weights["static-rules"]).toBeGreaterThan(0);
    expect(weights["static-rules"]).toBeLessThanOrEqual(1.0);
  });

  test("AC14: ignored verdicts for feature-kind chunks still produce a weight", () => {
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`f-${i}`, "feature-context", "feature"));
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["feature-context"]).toBeGreaterThan(0);
    expect(weights["feature-context"]).toBeLessThanOrEqual(1.0);
  });

  test("AC14: ignored verdicts for test-coverage-kind chunks still produce a weight", () => {
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`t-${i}`, "test-coverage", "test-coverage"));
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["test-coverage"]).toBeGreaterThan(0);
    expect(weights["test-coverage"]).toBeLessThanOrEqual(1.0);
  });

  test("AC14 (mixed FLOOR_KINDS): all three floor kinds contribute their provider weights", () => {
    const verdicts: ChunkVerdict[] = [];
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`s-${i}`, "static-rules", "static"));
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`f-${i}`, "feature-context", "feature"));
    for (let i = 0; i < 8; i++) verdicts.push(ignoredChunk(`t-${i}`, "test-coverage", "test-coverage"));
    const weights = deriveProviderWeights([ignoredManifest(verdicts)]);
    expect(weights["static-rules"]).toBeGreaterThan(0);
    expect(weights["feature-context"]).toBeGreaterThan(0);
    expect(weights["test-coverage"]).toBeGreaterThan(0);
  });
});
