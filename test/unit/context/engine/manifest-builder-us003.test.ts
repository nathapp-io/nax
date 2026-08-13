/**
 * manifest-builder.ts — US-003 chunkProviders tests
 *
 * Covers AC1, AC2, AC3 of US-003:
 *   - AC1: chunkProviders maps every packed chunk ID to its providerId
 *   - AC2: a packed chunk without providerId leaves no key in chunkProviders
 *   - AC3: when every packed chunk lacks providerId, chunkProviders is absent
 *
 * The carrier mirrors the existing chunkScopePaths precedent: an ID-keyed
 * sibling map, omitted entirely when empty. `providerId` is stamped by
 * `enrichRaw()` in the orchestrator before scoring, so every chunk that
 * reaches buildManifest through the normal pipeline carries one — but the
 * test surface accepts explicit overrides so the un-enriched path is
 * covered too.
 */

import { describe, expect, test } from "bun:test";
import { buildManifest } from "@/context/engine";
import type { ManifestInputs } from "@/context/engine";
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
  storyId: "US-003",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8_000,
};

function makeInputs(overrides: Partial<ManifestInputs> = {}): ManifestInputs {
  return {
    requestId: "req-us003",
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
    floorPackedIds: [],
    floorOverageIds: [],
    effectiveBudget: 8_000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: chunkProviders maps every chunk ID to its providerId
// ─────────────────────────────────────────────────────────────────────────────

describe("buildManifest — chunkProviders mapping (AC1)", () => {
  test("AC1: chunkProviders includes every packed chunk ID mapped to its providerId", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "static-rules:agents:section-a:deadbeef",
        providerId: "static-rules",
        tokens: 50,
      }),
      makePacked({
        id: "git-history:src/foo.ts:abcdef01",
        providerId: "git-history",
        tokens: 80,
      }),
      makePacked({
        id: "code-neighbor:src/foo.ts:12345678",
        providerId: "code-neighbor",
        tokens: 100,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 230 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkProviders).toBeDefined();
    expect(manifest.chunkProviders?.["static-rules:agents:section-a:deadbeef"]).toBe("static-rules");
    expect(manifest.chunkProviders?.["git-history:src/foo.ts:abcdef01"]).toBe("git-history");
    expect(manifest.chunkProviders?.["code-neighbor:src/foo.ts:12345678"]).toBe("code-neighbor");
  });

  test("AC1 (single chunk): chunkProviders maps the one packed chunk ID to its providerId", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "feature-context:feat-auth:s1:cafebabe",
        providerId: "feature-context",
        tokens: 100,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 100 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkProviders).toBeDefined();
    expect(Object.keys(manifest.chunkProviders ?? {})).toEqual(["feature-context:feat-auth:s1:cafebabe"]);
    expect(manifest.chunkProviders?.["feature-context:feat-auth:s1:cafebabe"]).toBe("feature-context");
  });

  test("AC1 (mixed providers): different providerIds for different chunk IDs are all preserved", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "static-rules:global:section-a:11111111",
        providerId: "static-rules",
        tokens: 50,
      }),
      makePacked({
        id: "static-rules:local:section-b:22222222",
        providerId: "static-rules",
        tokens: 60,
      }),
      makePacked({
        id: "git-history:src/foo.ts:33333333",
        providerId: "git-history",
        tokens: 70,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 180 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkProviders).toBeDefined();
    // Two chunks from "static-rules" — both keyed, both map to the same provider.
    expect(manifest.chunkProviders?.["static-rules:global:section-a:11111111"]).toBe("static-rules");
    expect(manifest.chunkProviders?.["static-rules:local:section-b:22222222"]).toBe("static-rules");
    expect(manifest.chunkProviders?.["git-history:src/foo.ts:33333333"]).toBe("git-history");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: a packed chunk without providerId leaves no key
// ─────────────────────────────────────────────────────────────────────────────

describe("buildManifest — chunkProviders omits chunks without providerId (AC2)", () => {
  test("AC2: a packed chunk with no providerId leaves no key in chunkProviders", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "static-rules:agents:section-a:deadbeef",
        providerId: "static-rules",
        tokens: 50,
      }),
      // No providerId on this chunk — it should be absent from the map.
      makePacked({
        id: "feature-context:feat-auth:s1:cafebabe",
        tokens: 100,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 150 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkProviders).toBeDefined();
    expect(manifest.chunkProviders?.["static-rules:agents:section-a:deadbeef"]).toBe("static-rules");
    // Boundary: chunk without providerId is NOT keyed
    expect(manifest.chunkProviders?.["feature-context:feat-auth:s1:cafebabe"]).toBeUndefined();
    expect(Object.keys(manifest.chunkProviders ?? {}).sort()).toEqual(["static-rules:agents:section-a:deadbeef"]);
  });

  test("AC2 (providerId explicitly undefined): a chunk with explicit providerId=undefined is also skipped", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "static-rules:agents:section-a:deadbeef",
        providerId: undefined,
        tokens: 50,
      }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 50 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkProviders).toBeUndefined();
  });

  test("AC2 (boundary): a packed chunk list with no providerId on any chunk omits chunkProviders entirely (AC3 cross-coverage)", () => {
    // This is also AC3 — kept here as a boundary so the AC2 path covers the
    // mixed case while AC3 covers the all-undefined case.
    const packed: PackedChunk[] = [
      makePacked({ id: "feature-context:feat-auth:s1:cafebabe", tokens: 100 }),
      makePacked({ id: "git-history:src/foo.ts:abcdef01", tokens: 80 }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 180 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkProviders).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: chunkProviders is absent when no packed chunk has providerId
// ─────────────────────────────────────────────────────────────────────────────

describe("buildManifest — chunkProviders omitted when no providerId (AC3)", () => {
  test("AC3 (no packed chunks): chunkProviders is omitted entirely", () => {
    const inputs = makeInputs({ packed: [], usedTokens: 0 });
    const manifest = buildManifest(inputs);
    expect(manifest.chunkProviders).toBeUndefined();
  });

  test("AC3 (all packed chunks un-attributed): chunkProviders is omitted entirely", () => {
    // A bundle of un-attributed chunks (synthetic callers, legacy manifests
    // being rebuilt) must NOT carry an empty {} object — omission is the
    // contract, mirroring chunkScopePaths.
    const packed: PackedChunk[] = [
      makePacked({ id: "feature-context:feat-auth:s1:cafebabe", tokens: 100 }),
      makePacked({ id: "git-history:src/foo.ts:abcdef01", tokens: 80 }),
      makePacked({ id: "code-neighbor:src/foo.ts:12345678", tokens: 60 }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 240 });
    const manifest = buildManifest(inputs);
    expect(manifest.chunkProviders).toBeUndefined();
  });

  test("AC3 (mixed: some attributed, some not): chunkProviders is present and only lists attributed chunks", () => {
    const packed: PackedChunk[] = [
      makePacked({
        id: "static-rules:agents:section-a:deadbeef",
        providerId: "static-rules",
        tokens: 50,
      }),
      makePacked({ id: "feature-context:feat-auth:s1:cafebabe", tokens: 100 }),
    ];
    const inputs = makeInputs({ packed, usedTokens: 150 });
    const manifest = buildManifest(inputs);

    expect(manifest.chunkProviders).toBeDefined();
    // Only the attributed chunk is keyed
    expect(Object.keys(manifest.chunkProviders ?? {}).sort()).toEqual(["static-rules:agents:section-a:deadbeef"]);
    expect(manifest.chunkProviders?.["static-rules:agents:section-a:deadbeef"]).toBe("static-rules");
  });
});
