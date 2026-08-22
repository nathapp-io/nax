import type { ContextManifest } from "@/context/engine/manifest-types";
/**
 * `ContextBundle` fixtures.
 *
 * The bundle itself is a plain interface, so a complete literal satisfies it —
 * the 14 casts across 12 files were all about its `manifest`, which needs nine
 * fields no assertion ever reads. Tests wrote four of them and cast the rest
 * away (#1514 phase 1b).
 *
 * No cast here: the defaults are complete, so the compiler checks the
 * overrides callers actually care about.
 */
import type { ContextBundle, ContextChunk } from "@/context/engine/types";

export function makeContextManifest(overrides: Partial<ContextManifest> = {}): ContextManifest {
  return {
    requestId: "test-request",
    stage: "implementer",
    totalBudgetTokens: 0,
    usedTokens: 0,
    includedChunks: [],
    excludedChunks: [],
    floorItems: [],
    digestTokens: 0,
    buildMs: 0,
    ...overrides,
  };
}

export function makeContextBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    pushMarkdown: "",
    pullTools: [],
    digest: "",
    manifest: makeContextManifest(),
    chunks: [] as ContextChunk[],
    ...overrides,
  };
}
