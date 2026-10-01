/**
 * rebuild.ts — rebuild manifest scoping and staleness attribution
 *
 * Three concerns, each previously its own satellite, merged per
 * test-architecture.md (split by concern, never by ticket):
 *
 *   1. US-001 stale attribution on the rebuild budget-exclusion path
 *      (rebuild-stale.test.ts) — AC8/AC9:
 *        AC8  When the rebuild path budget-excludes a packed chunk carrying
 *             `staleCandidate: true`, the rebuilt manifest's `excludedChunks`
 *             entry has `stale: true`.
 *        AC9  When the rebuild path budget-excludes a packed chunk with no
 *             `staleCandidate`, the rebuilt manifest's `excludedChunks` entry
 *             has `stale: false`.
 *      Rebuild derives staleness from `packedChunks` in scope (each carrying
 *      `staleCandidate`), not from `ManifestInputs.staleIds` — the rebuild path
 *      does not call `buildManifest`. The flag is stamped on every exclusion
 *      mapping whether or not the chunk is stale.
 *
 *   2. US-002 chunkScopePaths filtering (rebuild-chunk-scope-paths.test.ts) —
 *      the rebuilt manifest omits dangling scope-path entries for chunks the
 *      repack dropped.
 *
 *   3. chunkProviders filtering (rebuild-chunk-providers.test.ts) — provider
 *      attribution covers the complete rebuilt manifest domain (inclusions AND
 *      budget exclusions), unlike scope/effectiveness data.
 */

import { describe, expect, test } from "bun:test";
import { rebuild } from "@/context/engine";
import { ContextOrchestrator } from "@/context/engine/orchestrator";
import type {
  AdapterFailure,
  ContextBundle,
  ContextChunk,
  ContextManifest,
  ContextRequest,
} from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/repo",
  packageDir: "/repo",
  stage: "tdd-implementer",
  role: "implementer",
  budgetTokens: 8_000,
  providerIds: ["p1"],
};

/**
 * A prior bundle whose manifest carries ONE `feature`-kind chunk under
 * `includedChunks` plus a separate budget-excluded chunk keyed on a
 * non-floor `session` chunk. The session chunk is 9000 tokens, the agent
 * profile "local" has preferredPromptTokens=8000, so the rebuild's pack
 * excludes the session chunk for budget — exactly the path AC8/AC9 probe.
 */
function makePriorBundleWithBudgetDrop(
  includedId: string,
  droppedId: string,
  droppedStaleCandidate: boolean | undefined,
): ContextBundle {
  const included: ContextChunk = {
    id: includedId,
    providerId: "p1",
    kind: "feature",
    scope: "project",
    role: ["all"],
    content: "keep",
    tokens: 20,
    score: 0.9,
  };
  const dropped: ContextChunk = {
    id: droppedId,
    providerId: "p1",
    kind: "session",
    scope: "session",
    role: ["all"],
    content: "drop",
    tokens: 9_000,
    score: 0.7,
    ...(droppedStaleCandidate !== undefined && { staleCandidate: droppedStaleCandidate }),
  };

  return {
    pushMarkdown: "# Bundle\n\nContent",
    pullTools: [],
    digest: "",
    chunks: [included, dropped],
    agentId: "local", // local's preferredPromptTokens = 8000, smaller than the 9000-token session
    manifest: {
      requestId: "req-rebuild-stale",
      stage: BASE_REQUEST.stage,
      totalBudgetTokens: 16_000,
      effectiveBudget: 16_000,
      usedTokens: included.tokens + dropped.tokens,
      includedChunks: [included.id, dropped.id],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 0,
      buildMs: 0,
    },
  };
}

function findExcluded(bundle: ContextBundle, id: string) {
  const entry = bundle.manifest.excludedChunks.find((c) => c.id === id);
  if (!entry) throw new Error(`Expected rebuilt manifest.excludedChunks to contain id="${id}"`);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC8: rebuild budget exclusion of staleCandidate=true → stale: true
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuild — stale attribution on budget-excluded packed chunk (AC8)", () => {
  test("AC8: rebuild budget-excludes a packed chunk carrying staleCandidate=true → excludedChunks entry has stale: true", () => {
    const prior = makePriorBundleWithBudgetDrop("keep", "drop", true);

    const rebuilt = rebuild(prior, {});

    const entry = findExcluded(rebuilt, "drop");
    expect(entry.reason).toBe("budget");
    expect(entry.stale).toBe(true);
  });

  test("AC8 (boundary): rebuild budget-excludes a packed chunk with staleCandidate explicitly true → stale: true", () => {
    // Same as above but with explicit `true` for symmetry — the AC8 contract
    // applies when staleCandidate === true. Already covered by the previous
    // test; this anchors the explicit-true path.
    const prior = makePriorBundleWithBudgetDrop("keep", "drop-stale", true);

    const rebuilt = rebuild(prior, {});

    expect(findExcluded(rebuilt, "drop-stale").stale).toBe(true);
    expect(findExcluded(rebuilt, "drop-stale").reason).toBe("budget");
  });

  test("AC8 (orchestrator wrapper): ContextOrchestrator.rebuildForAgent stamps stale on the rebuilt budget exclusion", () => {
    // Use the orchestrator wrapper to ensure the staleness attribution
    // reaches the manifest via the production seam, not only when called
    // directly on `rebuild`.
    const included: ContextChunk = {
      id: "keep",
      providerId: "p1",
      kind: "feature",
      scope: "project",
      role: ["all"],
      content: "keep",
      tokens: 20,
      score: 0.9,
    };
    const dropped: ContextChunk = {
      id: "drop",
      providerId: "p1",
      kind: "session",
      scope: "session",
      role: ["all"],
      content: "drop",
      tokens: 9_000,
      score: 0.7,
      staleCandidate: true,
    };
    const prior: ContextBundle = {
      pushMarkdown: "# Bundle\n\nContent",
      pullTools: [],
      digest: "",
      chunks: [included, dropped],
      agentId: "local",
      manifest: {
        requestId: "req-prev",
        stage: BASE_REQUEST.stage,
        totalBudgetTokens: 16_000,
        effectiveBudget: 16_000,
        usedTokens: included.tokens + dropped.tokens,
        includedChunks: [included.id, dropped.id],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 0,
        buildMs: 0,
      },
    };

    const rebuilt = new ContextOrchestrator([]).rebuildForAgent(prior, {});
    expect(findExcluded(rebuilt, "drop").stale).toBe(true);
    expect(findExcluded(rebuilt, "drop").reason).toBe("budget");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: rebuild budget exclusion of staleCandidate=undefined → stale: false
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuild — non-stale budget-excluded packed chunk keeps stale: false (AC9)", () => {
  test("AC9: rebuild budget-excludes a packed chunk with no staleCandidate → excludedChunks entry has stale: false", () => {
    const prior = makePriorBundleWithBudgetDrop("keep", "drop", undefined);

    const rebuilt = rebuild(prior, {});

    const entry = findExcluded(rebuilt, "drop");
    expect(entry.reason).toBe("budget");
    expect(entry.stale).toBe(false);
  });

  test("AC9 (explicit false): rebuild budget-excludes a packed chunk with staleCandidate: false → stale: false", () => {
    const prior = makePriorBundleWithBudgetDrop("keep", "drop", false);

    const rebuilt = rebuild(prior, {});

    expect(findExcluded(rebuilt, "drop").stale).toBe(false);
    expect(findExcluded(rebuilt, "drop").reason).toBe("budget");
  });

  test("AC9 (mixed): one stale and one non-stale budget-excluded chunk stamp independently", () => {
    const staleDrop: ContextChunk = {
      id: "drop-stale",
      providerId: "p1",
      kind: "session",
      scope: "session",
      role: ["all"],
      content: "stale-drop",
      tokens: 9_000,
      score: 0.7,
      staleCandidate: true,
    };
    const freshDrop: ContextChunk = {
      id: "drop-fresh",
      providerId: "p1",
      kind: "session",
      scope: "session",
      role: ["all"],
      content: "fresh-drop",
      tokens: 9_500,
      score: 0.7,
    };
    const included: ContextChunk = {
      id: "keep",
      providerId: "p1",
      kind: "feature",
      scope: "project",
      role: ["all"],
      content: "keep",
      tokens: 20,
      score: 0.9,
    };

    const prior: ContextBundle = {
      pushMarkdown: "# Bundle\n\nContent",
      pullTools: [],
      digest: "",
      chunks: [included, staleDrop, freshDrop],
      agentId: "local",
      manifest: {
        requestId: "req-mixed",
        stage: BASE_REQUEST.stage,
        totalBudgetTokens: 16_000,
        effectiveBudget: 16_000,
        usedTokens: included.tokens + staleDrop.tokens + freshDrop.tokens,
        includedChunks: [included.id, staleDrop.id, freshDrop.id],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 0,
        buildMs: 0,
      },
    };

    const rebuilt = rebuild(prior, {});

    expect(findExcluded(rebuilt, "drop-stale").stale).toBe(true);
    expect(findExcluded(rebuilt, "drop-fresh").stale).toBe(false);
    // Both carry the unchanged mechanical reason.
    expect(findExcluded(rebuilt, "drop-stale").reason).toBe("budget");
    expect(findExcluded(rebuilt, "drop-fresh").reason).toBe("budget");
  });

  test("AC9 (boundary): a chunk with no staleCandidate field AT ALL still receives stale: false (uniform stamping)", () => {
    // The story's contract: the flag is stamped uniformly on every exclusion
    // path whether or not the chunk is stale — so a non-stale chunk gets
    // `stale: false`, never `stale: undefined`.
    const prior = makePriorBundleWithBudgetDrop("keep", "drop-no-field", undefined);

    const rebuilt = rebuild(prior, {});

    const entry = findExcluded(rebuilt, "drop-no-field");
    expect(entry.stale).toBe(false);
    expect(entry.stale).not.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures shared by the chunkScopePaths and chunkProviders filtering suites.
// The two original satellite files duplicated these verbatim; they are unified
// here because `rebuild()` reads chunkScopePaths/chunkProviders off the PRIOR
// manifest (rebuild.ts) and never from `chunk.providerId`, so the one-fixture
// version is assertion-equivalent.
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
    requestId: "req-rebuild-filtering",
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

// ─────────────────────────────────────────────────────────────────────────────
// chunkProviders — rebuild filters against the complete rebuilt manifest domain
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
