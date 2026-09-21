/**
 * rebuild.ts — US-001 attribute staleness on the rebuild budget-exclusion path
 *
 * Covers AC8 and AC9 of "Attribute staleness on excluded chunks":
 *   AC8  When the rebuild path budget-excludes a packed chunk carrying
 *        `staleCandidate: true`, the rebuilt manifest's `excludedChunks`
 *        entry has `stale: true`.
 *   AC9  When the rebuild path budget-excludes a packed chunk with no
 *        `staleCandidate`, the rebuilt manifest's `excludedChunks` entry
 *        has `stale: false`.
 *
 * Rebuild derives staleness from `packedChunks` in scope (each carrying
 * `staleCandidate`), not from `ManifestInputs.staleIds` — the rebuild path
 * does not call `buildManifest`. The flag is stamped on every exclusion
 * mapping whether or not the chunk is stale.
 */

import { describe, expect, test } from "bun:test";
import { rebuild } from "@/context/engine";
import { ContextOrchestrator } from "@/context/engine/orchestrator";
import type { ContextBundle, ContextChunk, ContextRequest } from "@/context/engine/types";

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
