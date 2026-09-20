/**
 * Rebuild — chunkProviders filtering
 *
 * Verifies that `ContextOrchestrator.rebuildForAgent()` filters
 * `manifest.chunkProviders` against the complete rebuilt manifest domain.
 * Repack-dropped chunks retain attribution because they become exclusion
 * entries; mappings for IDs represented by neither inclusion nor exclusion
 * remain invalid.
 */

import { describe, expect, test } from "bun:test";
import { ContextOrchestrator } from "@/context/engine";
import type { AdapterFailure, ContextBundle, ContextChunk, ContextManifest } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (duplicated from rebuild-chunk-scope-paths.test.ts to keep this
// file self-contained per test-architecture.md.)
// ─────────────────────────────────────────────────────────────────────────────

const AVAILABILITY_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  message: "daily token quota exhausted",
  retriable: false,
};

function chunk(opts: {
  id: string;
  kind?: ContextChunk["kind"];
  scope?: ContextChunk["scope"];
  role?: ContextChunk["role"];
  content?: string;
  tokens?: number;
  rawScore?: number;
  score?: number;
}): ContextChunk {
  return {
    id: opts.id,
    providerId: opts.id.split(":")[0] ?? "p1",
    kind: opts.kind ?? "feature",
    scope: opts.scope ?? "feature",
    role: opts.role ?? ["all"],
    content: opts.content ?? `content for ${opts.id}`,
    tokens: opts.tokens ?? 100,
    rawScore: opts.rawScore ?? 0.8,
    score: opts.score ?? opts.rawScore ?? 0.8,
  };
}

function makeManifest(overrides: Partial<ContextManifest> = {}): ContextManifest {
  return {
    requestId: "req-chunk-providers",
    stage: "execution",
    totalBudgetTokens: 16_000,
    effectiveBudget: 16_000,
    usedTokens: 0,
    includedChunks: [],
    excludedChunks: [],
    floorItems: [],
    digestTokens: 0,
    buildMs: 0,
    ...overrides,
  };
}

function makeBundleFromChunks(
  chunks: ContextChunk[],
  manifestOverrides: Partial<ContextManifest> = {},
  agentId = "claude",
): ContextBundle {
  return {
    pushMarkdown: "",
    pullTools: [],
    digest: "",
    chunks,
    agentId,
    manifest: makeManifest({
      includedChunks: chunks.map((c) => c.id),
      floorItems: chunks
        .filter((c) => c.kind === "feature" || c.kind === "static" || c.kind === "test-coverage")
        .map((c) => c.id),
      usedTokens: chunks.reduce((s, c) => s + c.tokens, 0),
      ...manifestOverrides,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// chunkProviders — rebuild filters against the rebuilt chunk set
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuild — chunkProviders filtering", () => {
  test("a chunk dropped by repack remains attributed as an excluded chunk", async () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat-a", kind: "feature", tokens: 100 }),
        chunk({ id: "p1:sess-a", kind: "session", tokens: 5_000, content: "x".repeat(20_000) }),
        chunk({ id: "p1:sess-b", kind: "session", tokens: 5_000, content: "y".repeat(20_000) }),
        chunk({ id: "p1:sess-c", kind: "session", tokens: 5_000, content: "z".repeat(20_000) }),
      ],
      {
        effectiveBudget: 16_000,
        chunkProviders: {
          "p1:feat-a": "feature-context",
          "p1:sess-a": "session-scratch",
          "p1:sess-b": "session-scratch",
          "p1:sess-c": "session-scratch",
        },
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const rebuiltIds = new Set(rebuilt.chunks.map((c) => c.id));
    const rebuiltProviders = rebuilt.manifest.chunkProviders;

    const manifestIds = new Set([
      ...rebuilt.manifest.includedChunks,
      ...rebuilt.manifest.excludedChunks.map((chunk) => chunk.id),
    ]);

    // Every provider key belongs to a chunk represented by the rebuilt manifest.
    expect(rebuiltProviders).toBeDefined();
    for (const id of Object.keys(rebuiltProviders ?? {})) {
      expect(manifestIds.has(id)).toBe(true);
    }

    // The prior's chunkProviders covered all four chunks; at least one
    // session chunk must be excluded by the rebuild (conservative ceiling
    // is 8_000, prior total is 15_100+). The mapping must reflect the drop.
    const priorProviders = prior.manifest.chunkProviders ?? {};
    const droppedIds = Object.keys(priorProviders).filter((id) => !rebuiltIds.has(id));
    expect(droppedIds.length).toBeGreaterThan(0);
    for (const droppedId of droppedIds) {
      expect(rebuilt.manifest.excludedChunks.some((chunk) => chunk.id === droppedId)).toBe(true);
      expect(rebuiltProviders?.[droppedId]).toBe(priorProviders[droppedId]);
    }
  });

  test("when every prior attributed chunk survives the rebuild, rebuilt chunkProviders preserves each entry verbatim", async () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat-a", kind: "feature", tokens: 100 }),
        chunk({ id: "p1:feat-b", kind: "feature", tokens: 100 }),
      ],
      {
        effectiveBudget: 16_000,
        chunkProviders: {
          "p1:feat-a": "feature-context",
          "p1:feat-b": "feature-context",
        },
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.manifest.chunkProviders).toEqual({
      "p1:feat-a": "feature-context",
      "p1:feat-b": "feature-context",
    });
  });

  test("when attributed chunks are dropped, rebuilt chunkProviders covers their exclusion entries", async () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:sess-a", kind: "session", tokens: 5_000 }),
        chunk({ id: "p1:sess-b", kind: "session", tokens: 5_000 }),
        chunk({ id: "p1:sess-c", kind: "session", tokens: 5_000 }),
        chunk({ id: "p1:sess-d", kind: "session", tokens: 5_000 }),
      ],
      {
        effectiveBudget: 16_000,
        // Only the doomed session chunks carry provider attribution; the
        // rebuild against the conservative 8_000 ceiling is guaranteed to
        // drop at least one.
        chunkProviders: {
          "p1:sess-a": "session-scratch",
          "p1:sess-b": "session-scratch",
          "p1:sess-c": "session-scratch",
          "p1:sess-d": "session-scratch",
        },
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    const rebuiltProviders = rebuilt.manifest.chunkProviders ?? {};
    const manifestIds = new Set([
      ...rebuilt.manifest.includedChunks,
      ...rebuilt.manifest.excludedChunks.map((chunk) => chunk.id),
    ]);
    for (const id of Object.keys(rebuiltProviders)) {
      expect(manifestIds.has(id)).toBe(true);
    }
    for (const excluded of rebuilt.manifest.excludedChunks) {
      expect(rebuiltProviders[excluded.id]).toBe("session-scratch");
    }
  });
});
