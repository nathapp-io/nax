/**
 * manifest-builder.ts — scopePaths mapping, stale attribution, eviction
 *
 * Three concerns, each previously its own satellite, merged per
 * test-architecture.md (split by concern, never by ticket):
 *   1. US-002 scopePaths / chunkScopePaths — AC1 (RawChunk accepts scopePaths
 *      and accepts chunks without it), AC5 (buildManifest maps a packed scoped
 *      chunk ID to its globs in chunkScopePaths), AC6 (omits chunkScopePaths
 *      when no packed chunk has scopePaths). RawChunk is the raw-chunk shape
 *      produced by IContextProvider.fetch().
 *   2. US-001 stale attribution on excluded chunks — AC1–AC6: the `stale` flag
 *      is stamped on every exclusion path (budgetExcludedIds, belowMin,
 *      dedupeDropped, roleFiltered) from `staleIds`, and defaults to false for
 *      an empty or non-intersecting set.
 *   3. Finding 5 eviction measurability — `chunkTokens` records a token cost
 *      for excluded chunks as well as included ones, and `floorOverageTokens`
 *      is forwarded verbatim and omitted when no floor chunk crossed.
 */

import { describe, expect, test } from "bun:test";
import type { ManifestInputs } from "@/context/engine";
import { buildManifest } from "@/context/engine";
import type { PackedChunk } from "@/context/engine/packing";
import type { ContextRequest } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

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
  storyId: "US-002",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8_000,
};

function makeInputs(overrides: Partial<ManifestInputs> = {}): ManifestInputs {
  return {
    requestId: "req-us002",
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

function findExcluded(manifest: ReturnType<typeof buildManifest>, id: string) {
  const entry = manifest.excludedChunks.find((c) => c.id === id);
  if (!entry) throw new Error(`Expected excludedChunks to contain id="${id}"`);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: RawChunk accepts scopePaths: string[] AND accepts chunks without it
// ─────────────────────────────────────────────────────────────────────────────

describe("RawChunk scopePaths field (AC1)", () => {
  test("AC1.a: RawChunk accepts an explicit scopePaths: string[] field", () => {
    const chunk: PackedChunk = makePacked({
      id: "static-rules:agents:section-a:deadbeef",
      scopePaths: ["src/agents/**/*.ts"],
    });
    expect(chunk.scopePaths).toEqual(["src/agents/**/*.ts"]);
  });

  test("AC1.b: RawChunk accepts a chunk with no scopePaths field everywhere it is accepted today", () => {
    // Existing providers that don't populate scopePaths (whole-diff behaviour,
    // per the out-of-scope note) keep producing valid PackedChunks.
    const chunk: PackedChunk = makePacked({ id: "feature-context:feat-auth:s1:cafebabe" });
    expect(chunk.scopePaths).toBeUndefined();
    expect(chunk.id).toBe("feature-context:feat-auth:s1:cafebabe");
  });

  test("AC1.c: PackedChunk in buildManifest input may omit scopePaths (no validation error)", () => {
    // buildManifest() must not throw or coerce chunks that lack scopePaths.
    // Without this, providers that haven't been threaded through the new
    // field would fail to emit manifest entries at all.
    const inputs = makeInputs({
      packed: [makePacked({ id: "feature-context:feat-auth:s1:cafebabe", tokens: 50 })],
      usedTokens: 50,
    });
    const manifest = buildManifest(inputs);
    expect(manifest.chunkScopePaths).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: buildManifest maps a packed scoped chunk ID to its globs
// ─────────────────────────────────────────────────────────────────────────────

describe("buildManifest — chunkScopePaths mapping (AC5)", () => {
  test("AC5: chunkScopePaths includes the packed chunk ID mapped to its scopePaths globs", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "static-rules:agents:section-a:deadbeef",
        scopePaths: ["src/agents/**/*.ts"],
        tokens: 50,
      }),
      makePacked({
        id: "static-rules:global:section-b:abcdef01",
        tokens: 75,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 125 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkScopePaths).toBeDefined();
    expect(manifest.chunkScopePaths?.["static-rules:agents:section-a:deadbeef"]).toEqual(["src/agents/**/*.ts"]);
    // Chunk without scopePaths is NOT keyed in chunkScopePaths
    expect(manifest.chunkScopePaths?.["static-rules:global:section-b:abcdef01"]).toBeUndefined();
  });

  test("AC5 (multi-glob): chunkScopePaths preserves every glob in scopePaths verbatim, in order", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "static-rules:adapter:section-a:abcdef01",
        scopePaths: ["src/agents/acp/**", "src/operations/**", "src/pipeline/**"],
        tokens: 60,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 60 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkScopePaths?.["static-rules:adapter:section-a:abcdef01"]).toEqual([
      "src/agents/acp/**",
      "src/operations/**",
      "src/pipeline/**",
    ]);
  });

  test("AC5 (multiple scoped chunks): every packed chunk with scopePaths is mapped, with its own globs", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "static-rules:agents:section-a:deadbeef",
        scopePaths: ["src/agents/**/*.ts"],
        tokens: 50,
      }),
      makePacked({
        id: "static-rules:retry-strategy:section-b:abcdef01",
        scopePaths: ["src/operations/**"],
        tokens: 80,
      }),
      makePacked({
        id: "static-rules:test-writing:section-c:12345678",
        scopePaths: ["test/**/*.test.ts", "test/**/*.test.tsx"],
        tokens: 100,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 230 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkScopePaths?.["static-rules:agents:section-a:deadbeef"]).toEqual(["src/agents/**/*.ts"]);
    expect(manifest.chunkScopePaths?.["static-rules:retry-strategy:section-b:abcdef01"]).toEqual(["src/operations/**"]);
    expect(manifest.chunkScopePaths?.["static-rules:test-writing:section-c:12345678"]).toEqual([
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: buildManifest omits chunkScopePaths when no packed chunk has scopePaths
// ─────────────────────────────────────────────────────────────────────────────

describe("buildManifest — chunkScopePaths omitted when empty (AC6)", () => {
  test("AC6 (no packed chunks): chunkScopePaths is omitted entirely", () => {
    const inputs = makeInputs({ packed: [], usedTokens: 0 });
    const manifest = buildManifest(inputs);
    expect(manifest.chunkScopePaths).toBeUndefined();
  });

  test("AC6 (packed chunks all un-scoped): chunkScopePaths is omitted entirely", () => {
    // A bundle of un-scoped chunks (e.g. feature-context or git-history chunks,
    // or static-rules chunks whose rules all lack appliesTo:) must NOT carry
    // an empty {} object — omission is the contract.
    const packed: PackedChunk[] = [
      makePacked({ id: "feature-context:feat-auth:s1:cafebabe", tokens: 100 }),
      makePacked({ id: "git-history:src/agents/call.ts:abcdef01", tokens: 250 }),
      makePacked({ id: "code-neighbor:src/agents/call.ts:12345678", tokens: 80 }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 430 });
    const manifest = buildManifest(inputs);
    expect(manifest.chunkScopePaths).toBeUndefined();
  });

  test("AC6 (mixed: some scoped, some not): chunkScopePaths is present and only lists the scoped ones", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "static-rules:agents:section-a:deadbeef",
        scopePaths: ["src/agents/**/*.ts"],
        tokens: 50,
      }),
      makePacked({ id: "feature-context:feat-auth:s1:cafebabe", tokens: 100 }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 150 });
    const manifest = buildManifest(inputs);

    // Presence check
    expect(manifest.chunkScopePaths).toBeDefined();
    // Only the scoped chunk is keyed
    expect(Object.keys(manifest.chunkScopePaths ?? {}).sort()).toEqual(["static-rules:agents:section-a:deadbeef"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 (git-history specific): a packed git-history chunk carrying
// scopePaths (US-001) must map to its scopePaths list under chunkScopePaths.
// Mirrors the AC5 mapping test above but with a git-history chunk ID and the
// scopePaths the US-001 provider emits (relative file paths that actually
// contributed a history section).
// ─────────────────────────────────────────────────────────────────────────────

describe("buildManifest — git-history chunkScopePaths (US-001 AC5)", () => {
  test("AC5 (git-history): chunkScopePaths maps a packed git-history chunk ID to its scopePaths list", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "git-history:abcdef0123456789",
        scopePaths: ["src/foo.ts", "src/bar.ts"],
        tokens: 250,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 250 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkScopePaths).toBeDefined();
    expect(manifest.chunkScopePaths?.["git-history:abcdef0123456789"]).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  test("AC5 (git-history, single-file): chunkScopePaths preserves a one-element list", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "git-history:12345678",
        scopePaths: ["src/only.ts"],
        tokens: 100,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 100 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkScopePaths?.["git-history:12345678"]).toEqual(["src/only.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — code-neighbor chunkScopePaths: a packed code-neighbor chunk
// carrying scopePaths (the touched file plus each rendered neighbor path)
// must map to its scopePaths list under chunkScopePaths.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildManifest — code-neighbor chunkScopePaths (US-002 AC5)", () => {
  test("AC5: chunkScopePaths maps a packed code-neighbor chunk ID to its scopePaths list", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "code-neighbor:deadbeef",
        scopePaths: ["src/foo.ts", "src/foo/dep.ts", "test/unit/foo.test.ts"],
        tokens: 80,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 80 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkScopePaths).toBeDefined();
    expect(manifest.chunkScopePaths?.["code-neighbor:deadbeef"]).toEqual([
      "src/foo.ts",
      "src/foo/dep.ts",
      "test/unit/foo.test.ts",
    ]);
  });

  test("AC5 (multi-chunk): code-neighbor chunk with shared-neighbor dedup is preserved verbatim", () => {
    // AC4 from the provider: shared neighbour across two touched files
    // appears exactly once in scopePaths. buildManifest forwards that list
    // verbatim — it does not re-dedupe or re-order.
    const packed: PackedChunk[] = [
      makePacked({
        id: "code-neighbor:abcdef01",
        scopePaths: ["src/foo.ts", "src/shared.ts", "src/bar.ts"],
        tokens: 100,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 100 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkScopePaths?.["code-neighbor:abcdef01"]).toEqual(["src/foo.ts", "src/shared.ts", "src/bar.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 stale attribution on excluded chunks (manifest-builder-stale.test.ts)
//
// AC1  budgetExcludedIds entry whose ID is in staleIds → stale: true.
// AC2  the mechanical `reason` ("budget") is preserved — stale is additive.
// AC3  belowMin entry whose ID is in staleIds → stale: true.
// AC4  dedupeDropped ID in staleIds → stale: true.
// AC5  roleFiltered ID in staleIds → stale: true.
// AC6  empty staleIds → every excludedChunks entry has stale: false.
//
// The flag is stamped uniformly on every exclusion path whether or not the
// chunk is stale (production reachability is narrower — only dedupe and
// role-filter can carry a stale chunk — but the unit criteria pin the uniform
// stamping).
// ─────────────────────────────────────────────────────────────────────────────

describe("buildManifest — stale attribution: budgetExcludedIds (AC1)", () => {
  test("AC1: a budgetExcludedIds entry whose ID is in staleIds has stale equal to true", () => {
    const inputs = makeInputs({
      budgetExcludedIds: ["budget-stale"],
      staleIds: new Set(["budget-stale"]),
    });

    const manifest = buildManifest(inputs);

    expect(findExcluded(manifest, "budget-stale").stale).toBe(true);
  });

  test("AC1 (multiple budget excluded, only some stale): each budget-excluded ID stamps stale independently", () => {
    const inputs = makeInputs({
      budgetExcludedIds: ["b-1", "b-2", "b-3"],
      staleIds: new Set(["b-1", "b-3"]),
    });

    const manifest = buildManifest(inputs);

    expect(findExcluded(manifest, "b-1").stale).toBe(true);
    expect(findExcluded(manifest, "b-2").stale).toBe(false);
    expect(findExcluded(manifest, "b-3").stale).toBe(true);
  });

  // AC1 boundary: a budget-excluded chunk NOT in staleIds must keep stale=false.
  test("AC1 boundary: a budgetExcludedIds entry whose ID is NOT in staleIds has stale equal to false", () => {
    const inputs = makeInputs({
      budgetExcludedIds: ["b-not-stale"],
      staleIds: new Set(),
    });

    const manifest = buildManifest(inputs);

    expect(findExcluded(manifest, "b-not-stale").stale).toBe(false);
  });
});

describe("buildManifest — stale attribution preserves mechanical reason (AC2)", () => {
  test("AC2: a stale budget-excluded chunk still has reason 'budget', with stale alongside", () => {
    const inputs = makeInputs({
      budgetExcludedIds: ["budget-stale"],
      staleIds: new Set(["budget-stale"]),
    });

    const manifest = buildManifest(inputs);
    const entry = findExcluded(manifest, "budget-stale");

    expect(entry.reason).toBe("budget");
    expect(entry.stale).toBe(true);
  });

  test("AC2 (negative): reason union does not include 'stale' — no chunk may carry reason='stale'", () => {
    // The 'stale' union member was removed because staleness is now an
    // orthogonal axis on the flag, not a reason. If the implementation ever
    // resurrects reason='stale', it must surface as a stringly-typed
    // assertion error here.
    const inputs = makeInputs({
      budgetExcludedIds: ["budget-stale"],
      staleIds: new Set(["budget-stale"]),
    });

    const manifest = buildManifest(inputs);

    for (const entry of manifest.excludedChunks) {
      expect(entry.reason).not.toBe("stale");
    }
  });
});

describe("buildManifest — stale attribution: belowMin (AC3)", () => {
  test("AC3: a belowMin entry whose ID is in staleIds has stale equal to true", () => {
    const inputs = makeInputs({
      belowMin: [{ id: "below-stale" }],
      staleIds: new Set(["below-stale"]),
    });

    const manifest = buildManifest(inputs);

    expect(findExcluded(manifest, "below-stale").stale).toBe(true);
    // Reason still 'below-min-score' (mechanical cause preserved).
    expect(findExcluded(manifest, "below-stale").reason).toBe("below-min-score");
  });

  test("AC3 boundary: a belowMin entry whose ID is NOT in staleIds has stale equal to false", () => {
    const inputs = makeInputs({
      belowMin: [{ id: "below-not-stale" }],
      staleIds: new Set(),
    });

    const manifest = buildManifest(inputs);

    expect(findExcluded(manifest, "below-not-stale").stale).toBe(false);
  });
});

describe("buildManifest — stale attribution: dedupeDropped (AC4)", () => {
  test("AC4: a dedupeDropped ID in staleIds has stale equal to true", () => {
    const inputs = makeInputs({
      dedupeDropped: ["dup-stale"],
      staleIds: new Set(["dup-stale"]),
    });

    const manifest = buildManifest(inputs);

    expect(findExcluded(manifest, "dup-stale").stale).toBe(true);
    expect(findExcluded(manifest, "dup-stale").reason).toBe("dedupe");
  });

  test("AC4 (mixed): a stale and a non-stale dedupeDropped ID stamp independently", () => {
    const inputs = makeInputs({
      dedupeDropped: ["dup-a", "dup-b"],
      staleIds: new Set(["dup-a"]),
    });

    const manifest = buildManifest(inputs);

    expect(findExcluded(manifest, "dup-a").stale).toBe(true);
    expect(findExcluded(manifest, "dup-b").stale).toBe(false);
  });
});

describe("buildManifest — stale attribution: roleFiltered (AC5)", () => {
  test("AC5: a roleFiltered ID in staleIds has stale equal to true", () => {
    const inputs = makeInputs({
      roleFiltered: [{ id: "role-stale" }],
      staleIds: new Set(["role-stale"]),
    });

    const manifest = buildManifest(inputs);

    expect(findExcluded(manifest, "role-stale").stale).toBe(true);
    expect(findExcluded(manifest, "role-stale").reason).toBe("role-filter");
  });

  test("AC5 boundary: a roleFiltered ID NOT in staleIds has stale equal to false", () => {
    const inputs = makeInputs({
      roleFiltered: [{ id: "role-not-stale" }],
      staleIds: new Set(),
    });

    const manifest = buildManifest(inputs);

    expect(findExcluded(manifest, "role-not-stale").stale).toBe(false);
  });
});

describe("buildManifest — empty staleIds leaves stale: false on every entry (AC6)", () => {
  test("AC6: with empty staleIds, every excludedChunks entry across all four classes has stale equal to false", () => {
    const inputs = makeInputs({
      roleFiltered: [{ id: "r1" }],
      belowMin: [{ id: "b1" }],
      dedupeDropped: ["d1"],
      budgetExcludedIds: ["x1"],
      staleIds: new Set(),
    });

    const manifest = buildManifest(inputs);

    expect(manifest.excludedChunks).toHaveLength(4);
    for (const entry of manifest.excludedChunks) {
      expect(entry.stale).toBe(false);
    }
  });

  test("AC6 boundary: a staleIds set containing only unrelated IDs leaves every entry's stale equal to false", () => {
    // The set could be non-empty but not intersect any exclusion list.
    // Stamp must default to false rather than being inherited from a
    // non-matching set membership.
    const inputs = makeInputs({
      roleFiltered: [{ id: "r1" }],
      belowMin: [{ id: "b1" }],
      dedupeDropped: ["d1"],
      budgetExcludedIds: ["x1"],
      staleIds: new Set(["unrelated-stale-id"]),
    });

    const manifest = buildManifest(inputs);

    for (const entry of manifest.excludedChunks) {
      expect(entry.stale).toBe(false);
    }
  });

  test("AC6 (no excluded chunks at all): manifest.excludedChunks is empty regardless of staleIds", () => {
    const inputs = makeInputs({ staleIds: new Set() });
    const manifest = buildManifest(inputs);
    expect(manifest.excludedChunks).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finding 5: make eviction measurable (manifest-builder-eviction.test.ts)
//
//   - `chunkTokens` records a token cost for excluded chunks (role-filter,
//     below-min-score, dedupe and budget) as well as included ones, so the
//     "budget evicted X tokens" question is answerable from the manifest.
//   - `floorOverageTokens` is forwarded verbatim and omitted when no floor
//     chunk crossed the ceiling.
// ─────────────────────────────────────────────────────────────────────────────

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
