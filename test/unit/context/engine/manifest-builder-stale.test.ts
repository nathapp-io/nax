/**
 * manifest-builder.ts — US-001 attribute staleness on excluded chunks
 *
 * Covers AC1–AC6 of "Attribute staleness on excluded chunks":
 *   AC1  buildManifest stamps `stale: true` on a budgetExcludedIds entry whose
 *        ID is in `staleIds`.
 *   AC2  buildManifest preserves the mechanical `reason` ("budget") on a
 *        stale-budget-excluded entry — the stale flag is additive, never
 *        replaces the cause.
 *   AC3  buildManifest stamps `stale: true` on a belowMin entry whose ID is in
 *        `staleIds`.
 *   AC4  buildManifest stamps `stale: true` on a dedupeDropped ID in `staleIds`.
 *   AC5  buildManifest stamps `stale: true` on a roleFiltered ID in `staleIds`.
 *   AC6  Empty `staleIds` → every `excludedChunks` entry has `stale: false`.
 *
 * The flag is stamped uniformly on every exclusion path whether or not the
 * chunk is stale, so AC6 covers the contract that `stale: false` is the
 * default for an empty staleIds set. Production reachability is narrower
 * (only `dedupe` and `role-filter` can carry a stale chunk per the Out of
 * Scope note); the unit criteria pin the uniform stamping here.
 */

import { describe, expect, test } from "bun:test";
import type { ManifestInputs } from "@/context/engine";
import { buildManifest } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

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
    requestId: "req-stale-attribution",
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
// AC1: budgetExcludedIds × staleIds → stale: true
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

// ─────────────────────────────────────────────────────────────────────────────
// AC2: stale flag preserves mechanical "budget" reason (no overwrite)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// AC3: belowMin × staleIds → stale: true
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// AC4: dedupeDropped × staleIds → stale: true
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// AC5: roleFiltered × staleIds → stale: true
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// AC6: empty staleIds → every excludedChunks entry has stale: false
// ─────────────────────────────────────────────────────────────────────────────

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
