/**
 * orchestrator.ts — US-004 effectiveness weights during scoring tests
 *
 * Covers AC5, AC6, AC9 of US-004. The story threads per-provider weights from
 * ContextRequest.providerWeights through scoreChunks, then into the manifest's
 * includedChunks / excludedChunks lists.
 *
 * AC5: a static-kind chunk whose low provider weight pushes it below the
 *      minimum → manifest.includedChunks lists it; manifest.excludedChunks does NOT.
 * AC6: a neighbor-kind chunk whose low provider weight pushes it below the
 *      minimum → manifest.excludedChunks lists it with reason "below-min-score".
 * AC9: assembling from a ContextRequest without providerWeights produces the same
 *      includedChunks / excludedChunks as an otherwise identical request with an
 *      empty weight mapping.
 *
 * The current stub ignores the request.providerWeights map (scoreChunk accepts
 * but does not apply it), so:
 *   - AC5: passes — static chunks are floor-included by the existing FLOOR_KINDS check.
 *   - AC6: fails — neighbor chunk's score is not reduced; it is included, not excluded.
 *   - AC9: passes — both undefined and {} produce identical results (weights unused).
 *
 * AC6 turns green when the stub multiplies by the keyed weight. AC5 and AC9
 * document behaviour the implementer must preserve.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { ContextOrchestrator, _orchestratorDeps } from "@/context/engine";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let _reqSeq = 0;
beforeEach(() => {
  _reqSeq = 0;
  _orchestratorDeps.uuid = () => `test-uuid-${++_reqSeq}` as `${string}-${string}-${string}-${string}-${string}`;
  _orchestratorDeps.now = () => Date.now();
});

const BASE_REQUEST: ContextRequest = {
  storyId: "US-004",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
  // Bypass stage-config provider filtering so all providers are activated.
  providerIds: ["static-rules", "code-neighbor", "feature-context"],
};

function makeProvider(
  id: string,
  result: Partial<ContextProviderResult> = {},
  kind: RawChunk["kind"] = "feature",
): IContextProvider {
  return {
    id,
    kind,
    fetch: async () => ({
      chunks: [],
      pullTools: [],
      ...result,
    }),
  };
}

function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return {
    id: "chunk:abc123",
    kind: "feature",
    scope: "feature",
    role: ["implementer"],
    content: "stub content",
    tokens: 100,
    rawScore: 1.0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC5: low provider weight keeps static-kind chunks in includedChunks
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator — static-kind floor inclusion survives low weight (AC5)", () => {
  test("AC5: static chunk whose low weight drops it below minScore stays in includedChunks", async () => {
    const staticChunk: RawChunk = makeChunk({
      id: "static-rules:rules-md",
      kind: "static",
      scope: "project",
      rawScore: 1.0,
    });
    const staticProvider = makeProvider("static-rules", { chunks: [staticChunk] }, "static");
    const orch = new ContextOrchestrator([staticProvider]);
    const request: ContextRequest = {
      ...BASE_REQUEST,
      providerWeights: { "static-rules": 0.05 }, // weight × kindWeight(1.0) = 0.05 < 0.1 (MIN_SCORE)
    };
    const bundle = await orch.assemble(request);
    expect(bundle.manifest.includedChunks).toContain("static-rules:rules-md");
    expect(bundle.manifest.excludedChunks.find((c) => c.id === "static-rules:rules-md")).toBeUndefined();
  });

  test("AC5 (with explicit minScore): low weight × low minScore still keeps static in includedChunks", async () => {
    const staticChunk: RawChunk = makeChunk({
      id: "static-rules:r",
      kind: "static",
      scope: "project",
      rawScore: 1.0,
    });
    const staticProvider = makeProvider("static-rules", { chunks: [staticChunk] }, "static");
    const orch = new ContextOrchestrator([staticProvider]);
    const request: ContextRequest = {
      ...BASE_REQUEST,
      minScore: 0.5, // explicitly raised
      providerWeights: { "static-rules": 0.05 },
    };
    const bundle = await orch.assemble(request);
    expect(bundle.manifest.includedChunks).toContain("static-rules:r");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: low provider weight excludes neighbor-kind chunks with reason below-min-score
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator — neighbor-kind excluded when low weight drops score below minScore (AC6)", () => {
  test("AC6: neighbor chunk whose low weight drops its score below MIN_SCORE is excluded with below-min-score", async () => {
    // neighbor kindWeight = 0.75. rawScore=0.5, weight=0.2 → 0.5 × 0.75 × 0.2 = 0.075 < 0.1.
    const neighborChunk: RawChunk = makeChunk({
      id: "code-neighbor:file-x",
      kind: "neighbor",
      scope: "feature",
      rawScore: 0.5,
    });
    const neighborProvider = makeProvider("code-neighbor", { chunks: [neighborChunk] }, "neighbor");
    const orch = new ContextOrchestrator([neighborProvider]);
    const request: ContextRequest = {
      ...BASE_REQUEST,
      providerWeights: { "code-neighbor": 0.2 },
    };
    const bundle = await orch.assemble(request);
    expect(bundle.manifest.includedChunks).not.toContain("code-neighbor:file-x");
    const excluded = bundle.manifest.excludedChunks.find((c) => c.id === "code-neighbor:file-x");
    expect(excluded).toBeDefined();
    expect(excluded?.reason).toBe("below-min-score");
  });

  test("AC6 (boundary): without low weight, the same chunk stays included", async () => {
    const neighborChunk: RawChunk = makeChunk({
      id: "code-neighbor:file-x",
      kind: "neighbor",
      scope: "feature",
      rawScore: 0.5,
    });
    const neighborProvider = makeProvider("code-neighbor", { chunks: [neighborChunk] }, "neighbor");
    const orch = new ContextOrchestrator([neighborProvider]);
    const bundle = await orch.assemble(BASE_REQUEST);
    // Without weights, score = 0.5 × 0.75 = 0.375 > MIN_SCORE — chunk is included.
    expect(bundle.manifest.includedChunks).toContain("code-neighbor:file-x");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: no providerWeights ≡ empty providerWeights
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator — undefined vs empty providerWeights produce identical results (AC9)", () => {
  test("AC9: includedChunks and excludedChunks match between undefined and empty weight maps", async () => {
    const chunks: RawChunk[] = [
      makeChunk({ id: "feature-context:f1", kind: "feature", scope: "feature", rawScore: 0.9 }),
      makeChunk({ id: "code-neighbor:n1", kind: "neighbor", scope: "feature", rawScore: 0.5 }),
      makeChunk({ id: "static-rules:s1", kind: "static", scope: "project", rawScore: 0.8 }),
    ];
    const provider = makeProvider("mixed-provider", { chunks }, "feature");

    const orch = new ContextOrchestrator([provider]);
    const withoutWeights = await orch.assemble(BASE_REQUEST);
    const withEmptyWeights = await orch.assemble({ ...BASE_REQUEST, providerWeights: {} });

    expect(withoutWeights.manifest.includedChunks).toEqual(withEmptyWeights.manifest.includedChunks);
    expect(withoutWeights.manifest.excludedChunks).toEqual(withEmptyWeights.manifest.excludedChunks);
  });

  test("AC9 (boundary): even when the request declares an empty map, behaviour matches no map at all", async () => {
    const chunks: RawChunk[] = [
      makeChunk({ id: "feature-context:f1", kind: "feature", scope: "feature", rawScore: 0.4 }),
    ];
    const provider = makeProvider("mixed-provider", { chunks }, "feature");

    const orch = new ContextOrchestrator([provider]);
    const withoutWeights = await orch.assemble(BASE_REQUEST);
    const withEmptyWeights = await orch.assemble({ ...BASE_REQUEST, providerWeights: {} });
    expect(withoutWeights.manifest.includedChunks).toEqual(withEmptyWeights.manifest.includedChunks);
  });
});
