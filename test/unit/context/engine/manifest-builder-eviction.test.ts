/**
 * manifest-builder.ts — Finding 5: make eviction measurable.
 *
 * Covers:
 *   - `chunkTokens` records a token cost for excluded chunks (role-filter,
 *     below-min-score, dedupe and budget) as well as included ones, so the
 *     "budget evicted X tokens" question is answerable from the manifest.
 *   - `floorOverageTokens` is forwarded verbatim and omitted when no floor
 *     chunk crossed the ceiling.
 */

import { describe, expect, test } from "bun:test";
import type { ManifestInputs } from "@/context/engine";
import { buildManifest } from "@/context/engine";
import type { PackedChunk } from "@/context/engine/packing";
import type { ContextRequest } from "@/context/engine/types";

function makePacked(overrides: Partial<PackedChunk> & { id: string }): PackedChunk {
  return {
    kind: "static",
    scope: "project",
    role: ["all"],
    content: `### rule-${overrides.id}\n\nbody`,
    tokens: 50,
    rawScore: 1.0,
    score: 1.0,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

const REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8_000,
};

function makeInputs(overrides: Partial<ManifestInputs> = {}): ManifestInputs {
  return {
    requestId: "req-finding5",
    request: REQUEST,
    packed: [],
    usedTokens: 0,
    digestTokens: 0,
    buildMs: 5,
    providerResults: [],
    roleFiltered: [],
    belowMin: [],
    dedupeDropped: [],
    budgetExcludedIds: [],
    chunkTokenLookup: new Map(),
    chunkProviderLookup: new Map(),
    floorPackedIds: [],
    floorOverageIds: [],
    floorOverageTokens: 0,
    effectiveBudget: 8_000,
    staleIds: new Set(),
    ...overrides,
  };
}

describe("buildManifest — chunkTokens covers excluded chunks (Finding 5)", () => {
  test("records token costs for role-filter, below-min, dedupe and budget excluded chunks", () => {
    const inputs = makeInputs({
      packed: [makePacked({ id: "included:1", tokens: 100 })],
      usedTokens: 100,
      roleFiltered: [{ id: "role:1" }],
      belowMin: [{ id: "below:1" }],
      dedupeDropped: ["dup:1"],
      budgetExcludedIds: ["budget:1"],
      chunkTokenLookup: new Map([
        ["included:1", 100],
        ["role:1", 10],
        ["below:1", 20],
        ["dup:1", 30],
        ["budget:1", 40],
      ]),
    });

    const manifest = buildManifest(inputs);

    expect(manifest.chunkTokens).toEqual({
      "included:1": 100,
      "role:1": 10,
      "below:1": 20,
      "dup:1": 30,
      "budget:1": 40,
    });
  });

  test("omits chunkTokens when neither included nor excluded chunks have a known cost", () => {
    const manifest = buildManifest(makeInputs());
    expect(manifest.chunkTokens).toBeUndefined();
  });

  test("an included chunk's own token cost is not overwritten by the lookup", () => {
    const inputs = makeInputs({
      packed: [makePacked({ id: "c:1", tokens: 100 })],
      usedTokens: 100,
      chunkTokenLookup: new Map([["c:1", 999]]),
    });

    expect(buildManifest(inputs).chunkTokens).toEqual({ "c:1": 100 });
  });

  test("an excluded id absent from the lookup leaves no chunkTokens key", () => {
    const inputs = makeInputs({
      packed: [],
      budgetExcludedIds: ["unknown:1"],
      chunkTokenLookup: new Map(),
    });

    expect(buildManifest(inputs).chunkTokens).toBeUndefined();
  });
});

describe("buildManifest — floorOverageTokens (Finding 5)", () => {
  test("forwards floorOverageItems and floorOverageTokens when the floor crossed", () => {
    const manifest = buildManifest(makeInputs({ floorOverageIds: ["feat:1", "tc:1"], floorOverageTokens: 900 }));

    expect(manifest.floorOverageItems).toEqual(["feat:1", "tc:1"]);
    expect(manifest.floorOverageTokens).toBe(900);
  });

  test("omits floorOverageItems and floorOverageTokens when no floor chunk crossed", () => {
    const manifest = buildManifest(makeInputs({ floorOverageIds: [], floorOverageTokens: 0 }));

    expect(manifest.floorOverageItems).toBeUndefined();
    expect(manifest.floorOverageTokens).toBeUndefined();
  });
});
