/**
 * manifest-builder.ts — US-002 scopePaths / chunkScopePaths tests
 *
 * Covers AC1 (RawChunk accepts scopePaths and accepts chunks without it),
 * AC5 (buildManifest maps a packed scoped chunk ID to its globs in
 * chunkScopePaths), and AC6 (buildManifest omits chunkScopePaths when no
 * packed chunk has scopePaths).
 *
 * RawChunk is the raw-chunk shape produced by IContextProvider.fetch(); AC1
 * verifies the type accepts the new optional field AND continues to accept
 * chunks without it (existing providers remain un-scoped).
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
    floorPackedIds: [],
    floorOverageIds: [],
    effectiveBudget: 8_000,
    ...overrides,
  };
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
