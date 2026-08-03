/**
 * manifest-builder.ts — rebuildUsedTokens() unit tests
 *
 * rebuildUsedTokens() must produce a usedTokens value that matches exactly
 * what rebuildForAgent() renders into pushMarkdown: the prior-digest
 * contribution counts ONLY when newPriorStageDigest (trimmed) is non-empty,
 * mirroring renderChunks()/renderForAgent()'s own `.trim()` gate. It must
 * never fall back to the prior bundle's own digest contribution when the
 * rebuild omits or blanks out newPriorStageDigest (US-001 AC-6).
 */

import { describe, test, expect } from "bun:test";
import { rebuildUsedTokens } from "@/context";
import type { ContextBundle, ContextChunk, PackedChunk } from "@/context";

function makeContextChunk(overrides: Partial<ContextChunk> = {}): ContextChunk {
  return {
    id: "chunk:1",
    providerId: "p1",
    kind: "feature",
    scope: "feature",
    role: ["all"],
    content: "content",
    tokens: 100,
    score: 0.8,
    ...overrides,
  };
}

function makePackedChunk(overrides: Partial<PackedChunk> = {}): PackedChunk {
  return {
    id: "chunk:1",
    kind: "feature",
    scope: "feature",
    role: ["all"],
    content: "content",
    tokens: 100,
    rawScore: 0.8,
    score: 0.8,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

function makePriorBundle(overrides: {
  chunks?: ContextChunk[];
  usedTokens: number;
}): ContextBundle {
  const chunks = overrides.chunks ?? [makeContextChunk({ id: "chunk:1", tokens: 100 })];
  return {
    pushMarkdown: "prior markdown",
    pullTools: [],
    digest: "",
    chunks,
    manifest: {
      requestId: "req-1",
      stage: "execution",
      totalBudgetTokens: 10_000,
      usedTokens: overrides.usedTokens,
      includedChunks: chunks.map((c) => c.id),
      excludedChunks: [],
      floorItems: [],
      digestTokens: 0,
      buildMs: 0,
      providerResults: [],
      repoRoot: "/project",
      packageDir: "/project",
    },
  };
}

describe("rebuildUsedTokens()", () => {
  test("omitted newPriorStageDigest: does not fall back to the prior bundle's digest contribution", () => {
    // Prior assemble() had a priorStageDigest baked into usedTokens (100 chunk
    // tokens + 60 digest tokens = 160), but this rebuild omits priorStageDigest
    // entirely — rebuildForAgent renders no "Prior Stage Summary" section, so
    // usedTokens must reflect only the packed chunk tokens (100), not the 160
    // total the old fallback logic would have produced.
    const prior = makePriorBundle({
      chunks: [makeContextChunk({ id: "chunk:1", tokens: 100 })],
      usedTokens: 160,
    });
    const packed = [makePackedChunk({ id: "chunk:1", tokens: 100 })];
    const result = rebuildUsedTokens(prior, packed, undefined);
    expect(result).toBe(100);
  });

  test("blank/whitespace newPriorStageDigest: does not fall back to the prior bundle's digest contribution", () => {
    const prior = makePriorBundle({
      chunks: [makeContextChunk({ id: "chunk:1", tokens: 100 })],
      usedTokens: 160,
    });
    const packed = [makePackedChunk({ id: "chunk:1", tokens: 100 })];
    const result = rebuildUsedTokens(prior, packed, "   \n\t  ");
    expect(result).toBe(100);
  });

  test("replacement newPriorStageDigest: counts the NEW digest's tokens, not the prior's", () => {
    const prior = makePriorBundle({
      chunks: [makeContextChunk({ id: "chunk:1", tokens: 100 })],
      usedTokens: 160, // prior had a 60-token digest contribution
    });
    const packed = [makePackedChunk({ id: "chunk:1", tokens: 100 })];
    const newDigest = "y".repeat(40); // 10 tokens (ceil(40/4))
    const result = rebuildUsedTokens(prior, packed, newDigest);
    expect(result).toBe(100 + 10);
  });

  test("prior bundle had no digest, rebuild adds one: counts only the new digest's tokens", () => {
    const prior = makePriorBundle({
      chunks: [makeContextChunk({ id: "chunk:1", tokens: 100 })],
      usedTokens: 100, // no prior digest contribution
    });
    const packed = [makePackedChunk({ id: "chunk:1", tokens: 100 })];
    const newDigest = "z".repeat(80); // 20 tokens
    const result = rebuildUsedTokens(prior, packed, newDigest);
    expect(result).toBe(100 + 20);
  });

  test("extra chunk added by rebuild (e.g. failure-note) is included in packedTokens", () => {
    const prior = makePriorBundle({
      chunks: [makeContextChunk({ id: "chunk:1", tokens: 100 })],
      usedTokens: 100,
    });
    const packed = [
      makePackedChunk({ id: "chunk:1", tokens: 100 }),
      makePackedChunk({ id: "failure-note:1", tokens: 50 }),
    ];
    const result = rebuildUsedTokens(prior, packed, undefined);
    expect(result).toBe(150);
  });
});
