/**
 * scoring.ts — US-003 PriorRunFailureProvider kind weight tests
 *
 * AC3: When scoreChunk scores a prior-failure chunk, then it applies kind weight 0.85.
 *
 * Mirrors the prior scoring-kind tests for diagnostics (0.95) and session (0.9).
 */

import { describe, expect, test } from "bun:test";
import { scoreChunk } from "@/context/engine";
import type { RawChunk } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
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
    const chunk = makeChunk({ rawScore: 1.0, kind: "prior-failure" });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=1.0, kindWeight=0.85, freshness=1.0
    expect(result.score).toBeCloseTo(0.85);
  });

  test("AC3: kind weight 0.85 applies with role=all", () => {
    const chunk = makeChunk({ rawScore: 1.0, kind: "prior-failure", role: ["all"] });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=0.9 (all→implementer), kindWeight=0.85
    expect(result.score).toBeCloseTo(0.9 * 0.85);
  });

  test("AC3: kind weight 0.85 applies multiplicatively with role mismatch score=0", () => {
    const chunk = makeChunk({ rawScore: 1.0, kind: "prior-failure", role: ["reviewer"] });
    const result = scoreChunk(chunk, "implementer");
    expect(result.roleFiltered).toBe(true);
    expect(result.score).toBe(0);
  });

  test("AC3: kind weight 0.85 produces higher score than rag (0.7) and lower than session (0.9)", () => {
    // Sanity-check the ordering vs the existing kind weights.
    const prior = scoreChunk(makeChunk({ kind: "prior-failure", rawScore: 1.0 }), "implementer").score;
    const session = scoreChunk(makeChunk({ kind: "session", rawScore: 1.0 }), "implementer").score;
    const rag = scoreChunk(makeChunk({ kind: "rag", rawScore: 1.0 }), "implementer").score;
    expect(prior).toBeGreaterThan(rag);
    expect(prior).toBeLessThan(session);
    expect(prior).toBeCloseTo(0.85);
  });
});
