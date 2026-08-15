/**
 * scoring.ts — US-004 LintConfigProvider kind weight tests
 *
 * AC3: When scoreChunk scores a lint-config chunk, then it applies kind weight 0.8.
 * AC4: When scoreChunk scores a static chunk, then it applies kind weight 1.0.
 *
 * Mirrors the prior scoring-kind tests for diagnostics (0.95), session (0.9),
 * and prior-failure (0.85).
 */

import { describe, expect, test } from "bun:test";
import { scoreChunk } from "@/context/engine";
import type { RawChunk } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
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
    const chunk = makeChunk({ rawScore: 1.0, kind: "lint-config" });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=1.0, kindWeight=0.8, freshness=1.0
    expect(result.score).toBeCloseTo(0.8);
  });

  test("AC3: kind weight 0.8 applies with role=all", () => {
    const chunk = makeChunk({ rawScore: 1.0, kind: "lint-config", role: ["all"] });
    const result = scoreChunk(chunk, "implementer");
    // roleMultiplier=0.9 (all→implementer), kindWeight=0.8
    expect(result.score).toBeCloseTo(0.9 * 0.8);
  });

  test("AC3: kind weight 0.8 produces higher score than neighbor (0.75) and lower than prior-failure (0.85)", () => {
    // Sanity-check the ordering vs the existing kind weights.
    const lint = scoreChunk(makeChunk({ kind: "lint-config", rawScore: 1.0 }), "implementer").score;
    const prior = scoreChunk(makeChunk({ kind: "prior-failure", rawScore: 1.0 }), "implementer").score;
    const neighbor = scoreChunk(makeChunk({ kind: "neighbor", rawScore: 1.0 }), "implementer").score;
    expect(lint).toBeGreaterThan(neighbor);
    expect(lint).toBeLessThan(prior);
    expect(lint).toBeCloseTo(0.8);
  });

  test("AC3: lint-config chunk is below the static floor weight (0.8 < 1.0)", () => {
    const lint = scoreChunk(makeChunk({ kind: "lint-config", rawScore: 1.0 }), "implementer").score;
    const staticScore = scoreChunk(
      { ...makeChunk({ kind: "static", rawScore: 1.0 }) },
      "implementer",
    ).score;
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
