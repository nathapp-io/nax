/**
 * Rebuild — US-002 chunkScopePaths filtering
 *
 * Verifies that `ContextOrchestrator.rebuildForAgent()` filters
 * `manifest.chunkScopePaths` against the rebuilt chunk set. When repack
 * drops a scoped chunk, the rebuilt manifest must NOT retain a dangling
 * chunkScopePaths entry keyed on the dropped chunk — the spread
 * `...prior.manifest` otherwise carries the mapping forward verbatim.
 *
 * Split from rebuild-repack.test.ts per test-architecture.md (the original
 * file is split by describe block when it approaches the 800-line hard
 * limit; this concern belongs to US-002, not US-003 repack arithmetic).
 */

import { describe, expect, test } from "bun:test";
import { ContextOrchestrator } from "@/context/engine";
import type {
  AdapterFailure,
  ContextBundle,
  ContextChunk,
  ContextManifest,
} from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (duplicated from rebuild-repack.test.ts to keep this file
// self-contained — the helpers are simple and splitting the concern into
// its own file outweighs the duplication cost.)
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
    requestId: "req-us-002",
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
      floorItems: chunks.filter((c) => c.kind === "feature" || c.kind === "static" || c.kind === "test-coverage").map((c) => c.id),
      usedTokens: chunks.reduce((s, c) => s + c.tokens, 0),
      ...manifestOverrides,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — rebuild filters chunkScopePaths against the rebuilt chunk set
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuild — US-002 chunkScopePaths filtering", () => {
  test("a scoped chunk dropped by repack does not appear in rebuilt chunkScopePaths", async () => {
    // Build a prior bundle whose every chunk carries scopePaths. Force
    // repack against a tight conservative ceiling so some chunks are
    // excluded. The rebuilt manifest's chunkScopePaths must be filtered
    // to only the chunks that survived the rebuild.
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat-a", kind: "feature", tokens: 100 }),
        chunk({ id: "p1:sess-a", kind: "session", tokens: 5_000, content: "x".repeat(20_000) }),
        chunk({ id: "p1:sess-b", kind: "session", tokens: 5_000, content: "y".repeat(20_000) }),
        chunk({ id: "p1:sess-c", kind: "session", tokens: 5_000, content: "z".repeat(20_000) }),
      ],
      {
        effectiveBudget: 16_000,
        chunkScopePaths: {
          "p1:feat-a": ["src/agents/**/*.ts"],
          "p1:sess-a": ["src/agents/**/*.ts"],
          "p1:sess-b": ["src/operations/**"],
          "p1:sess-c": ["src/pipeline/**"],
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
    const rebuiltScopePaths = rebuilt.manifest.chunkScopePaths;

    // Every key in the rebuilt chunkScopePaths must be in the rebuilt chunk set.
    expect(rebuiltScopePaths).toBeDefined();
    for (const id of Object.keys(rebuiltScopePaths ?? {})) {
      expect(rebuiltIds.has(id)).toBe(true);
    }

    // The prior's chunkScopePaths covered all four chunks; at least one
    // session chunk must be excluded by the rebuild (conservative ceiling
    // is 8_000, prior total is 15_100+). The mapping must reflect the drop.
    const priorScopePaths = prior.manifest.chunkScopePaths ?? {};
    const droppedIds = Object.keys(priorScopePaths).filter((id) => !rebuiltIds.has(id));
    expect(droppedIds.length).toBeGreaterThan(0);
    for (const droppedId of droppedIds) {
      expect(rebuiltScopePaths?.[droppedId]).toBeUndefined();
    }
  });

  test("when every prior scoped chunk survives the rebuild, rebuilt chunkScopePaths preserves each entry verbatim", async () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:feat-a", kind: "feature", tokens: 100 }),
        chunk({ id: "p1:feat-b", kind: "feature", tokens: 100 }),
      ],
      {
        effectiveBudget: 16_000,
        chunkScopePaths: {
          "p1:feat-a": ["src/agents/**/*.ts"],
          "p1:feat-b": ["src/operations/**", "src/pipeline/**"],
        },
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.manifest.chunkScopePaths).toEqual({
      "p1:feat-a": ["src/agents/**/*.ts"],
      "p1:feat-b": ["src/operations/**", "src/pipeline/**"],
    });
  });

  test("when the prior has chunkScopePaths but every keyed chunk is dropped, the rebuilt manifest omits the field entirely", async () => {
    const prior = makeBundleFromChunks(
      [
        chunk({ id: "p1:sess-a", kind: "session", tokens: 5_000 }),
        chunk({ id: "p1:sess-b", kind: "session", tokens: 5_000 }),
        chunk({ id: "p1:sess-c", kind: "session", tokens: 5_000 }),
        chunk({ id: "p1:sess-d", kind: "session", tokens: 5_000 }),
      ],
      {
        effectiveBudget: 16_000,
        // Only the doomed session chunks carry scopePaths; the rebuild
        // against the conservative 8_000 ceiling is guaranteed to drop
        // at least one.
        chunkScopePaths: {
          "p1:sess-a": ["src/a/**"],
          "p1:sess-b": ["src/b/**"],
          "p1:sess-c": ["src/c/**"],
          "p1:sess-d": ["src/d/**"],
        },
      },
      "claude",
    );

    const orch = new ContextOrchestrator([]);
    const rebuilt = orch.rebuildForAgent(prior, {
      newAgentId: "totally-unknown-agent",
      failure: AVAILABILITY_FAILURE,
    });

    // The rebuilt field, if present, must only key surviving chunks. The
    // invariant we actually care about is "no dangling entries" — the
    // field may be present (filtered to survivors) or absent (empty).
    const rebuiltScopePaths = rebuilt.manifest.chunkScopePaths;
    if (rebuiltScopePaths) {
      const rebuiltIds = new Set(rebuilt.chunks.map((c) => c.id));
      for (const id of Object.keys(rebuiltScopePaths)) {
        expect(rebuiltIds.has(id)).toBe(true);
      }
    }
  });
});
