/**
 * ContextOrchestrator.assemble — US-001 stale attribution through the dedupe path
 *
 * Covers AC7 of "Attribute staleness on excluded chunks":
 *   AC7  Given two providers whose chunk content has trigram Jaccard similarity
 *        at or above SIMILARITY_THRESHOLD (src/context/engine/dedupe.ts:21, 0.9
 *        — identical content satisfies it), and applyStaleness marks the
 *        lower-scoring chunk staleCandidate true with a scoreMultiplier below
 *        1, when assembly dedupes the chunks, then the manifest excludedChunks
 *        entry for the dropped chunk has stale true and reason "dedupe".
 *
 * This is the only production path that can reach a stale chunk today:
 * `dedupe` and `role-filter` are the two exclusion sites that can carry a
 * stale chunk under the existing exemption rules. The unit criteria pin
 * uniform stamping on every mapping; this integration criterion drives the
 * dedupe path end-to-end through the production seam.
 */

import { describe, expect, test } from "bun:test";
import { SIMILARITY_THRESHOLD } from "@/context/engine/dedupe";
import { ContextOrchestrator } from "@/context/engine/orchestrator";
import type { ContextProviderResult, ContextRequest, IContextProvider } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/repo",
  packageDir: "/repo",
  stage: "tdd-implementer",
  role: "implementer",
  budgetTokens: 8_000,
  providerIds: ["p1", "p2"],
};

function makeProvider(id: string, result: ContextProviderResult): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async () => result,
  };
}

/**
 * Two near-duplicate chunks sharing identical content (trigram Jaccard = 1.0
 * ≥ SIMILARITY_THRESHOLD). The lower-scoring chunk is marked staleCandidate
 * with a scoreMultiplier below 1 — applyStaleness()'s effect on the scoring
 * pass reduces its score further, so the higher-scoring non-stale chunk is
 * the dedupe representative and the stale one is dropped.
 */
function makeNearDuplicateResults(): ContextProviderResult[] {
  // Identical content → Jaccard similarity = 1.0 ≥ threshold.
  const sharedContent = "Always use the lint check before merging a pull request.";
  return [
    {
      chunks: [
        {
          id: "chunk-higher",
          providerId: "p1",
          kind: "feature",
          scope: "project",
          role: ["all"],
          content: sharedContent,
          tokens: 100,
          rawScore: 0.9,
        },
      ],
    },
    {
      chunks: [
        {
          id: "chunk-lower-stale",
          providerId: "p2",
          kind: "feature",
          scope: "project",
          role: ["all"],
          content: sharedContent,
          tokens: 100,
          rawScore: 0.8,
          staleCandidate: true,
          scoreMultiplier: 0.5,
        },
      ],
    },
  ];
}

function findExcluded(
  manifest: { excludedChunks: Array<{ id: string; reason: string; stale?: boolean }> },
  id: string,
) {
  const entry = manifest.excludedChunks.find((c) => c.id === id);
  if (!entry) throw new Error(`Expected excludedChunks to contain id="${id}"`);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC7: orchestrator dedupe path stamps stale: true on the dropped chunk
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator — stale attribution through dedupe (AC7)", () => {
  test("AC7: identical-content chunks (Jaccard >= SIMILARITY_THRESHOLD) → dropped stale chunk has stale: true, reason: 'dedupe'", async () => {
    const [r1, r2] = makeNearDuplicateResults();
    const orch = new ContextOrchestrator([makeProvider("p1", r1), makeProvider("p2", r2)]);

    const bundle = await orch.assemble(BASE_REQUEST);

    // Sanity: the threshold used in dedupe.ts is 0.9 — we pass with 1.0.
    expect(SIMILARITY_THRESHOLD).toBe(0.9);

    // Sanity: the stale chunk must have actually been dropped from
    // includedChunks and surfaced as excluded.
    expect(bundle.manifest.includedChunks).not.toContain("chunk-lower-stale");
    expect(bundle.manifest.excludedChunks.map((c) => c.id)).toContain("chunk-lower-stale");

    const entry = findExcluded(bundle.manifest, "chunk-lower-stale");
    expect(entry.reason).toBe("dedupe");
    expect(entry.stale).toBe(true);
  });

  test("AC7 (mechanical reason preserved): the dropped stale chunk keeps reason 'dedupe' rather than being re-labeled 'stale'", async () => {
    // The story's contract: the stale flag is additive, never replaces the
    // mechanical cause. reason='stale' is no longer a member of the union;
    // a stale chunk whose drop cause is dedupe must record reason='dedupe'.
    const [r1, r2] = makeNearDuplicateResults();
    const orch = new ContextOrchestrator([makeProvider("p1", r1), makeProvider("p2", r2)]);

    const bundle = await orch.assemble(BASE_REQUEST);

    for (const entry of bundle.manifest.excludedChunks) {
      expect(entry.reason).not.toBe("stale");
    }
    expect(findExcluded(bundle.manifest, "chunk-lower-stale").reason).toBe("dedupe");
  });

  test("AC7 (kept representative unchanged): the higher-scoring non-stale chunk survives dedupe and is not in excludedChunks", async () => {
    // Boundary: the non-stale representative is included, not excluded —
    // it does NOT get a stale stamp on a phantom excludedChunks entry.
    const [r1, r2] = makeNearDuplicateResults();
    const orch = new ContextOrchestrator([makeProvider("p1", r1), makeProvider("p2", r2)]);

    const bundle = await orch.assemble(BASE_REQUEST);

    expect(bundle.manifest.includedChunks).toContain("chunk-higher");
    expect(bundle.manifest.excludedChunks.map((c) => c.id)).not.toContain("chunk-higher");
  });
});
