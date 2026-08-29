/**
 * Context Stage — US-004 effectiveness weights during scoring tests
 *
 * Covers AC7, AC8, AC10 of US-004. The V2 context stage derives per-provider
 * effectiveness weights from the current feature's stored manifests and threads
 * them into the orchestrator via ContextRequest.providerWeights.
 *
 * AC7:  when deriveProviderWeights is stubbed to return known weights and
 *       contextStage.execute runs with config.context.v2.enabled true, then
 *       deriveProviderWeights is invoked once.
 * AC8:  when deriveProviderWeights is stubbed with a weight below 1.0 for a
 *       non-floor provider and contextStage.execute runs with config.context.v2
 *       .enabled true, then its written manifest records that provider chunk
 *       with a score strictly lower than the same run using weight 1.0.
 * AC10: when loadFeatureManifests is stubbed and contextStage.execute runs
 *       with config.context.v2.enabled true, then it is invoked with the
 *       pipeline context feature ID.
 *
 * Stub strategy:
 *   - loadFeatureManifests → returns an empty manifest list so deriveProviderWeights
 *     always has known input.
 *   - deriveProviderWeights → returns the test-supplied weights verbatim.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeContextOrchestrator, makeNaxConfig, makeTempDir } from "@test/helpers";
import type {
  ContextBundle,
  ContextManifest,
  ContextRequest,
  IContextProvider,
  StoredContextManifest,
} from "@/context/engine";
import { ContextOrchestrator } from "@/context/engine";
import { _contextStageDeps, contextStage } from "@/pipeline/stages";
import type { PipelineContext } from "@/pipeline/types";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals (restored per test)
// ─────────────────────────────────────────────────────────────────────────────

let origCreateOrchestrator: typeof _contextStageDeps.createOrchestrator;
let origReadDigest: typeof _contextStageDeps.readDigest;
let origWriteDigest: typeof _contextStageDeps.writeDigest;
let origUuid: typeof _contextStageDeps.uuid;
let origLoadFeatureManifests: typeof _contextStageDeps.loadFeatureManifests;
let origDeriveProviderWeights: typeof _contextStageDeps.deriveProviderWeights;

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("nax-ctx-us004-test-");
  origCreateOrchestrator = _contextStageDeps.createOrchestrator;
  origReadDigest = _contextStageDeps.readDigest;
  origWriteDigest = _contextStageDeps.writeDigest;
  origUuid = _contextStageDeps.uuid;
  origLoadFeatureManifests = _contextStageDeps.loadFeatureManifests;
  origDeriveProviderWeights = _contextStageDeps.deriveProviderWeights;
});

afterEach(() => {
  _contextStageDeps.createOrchestrator = origCreateOrchestrator;
  _contextStageDeps.readDigest = origReadDigest;
  _contextStageDeps.writeDigest = origWriteDigest;
  _contextStageDeps.uuid = origUuid;
  _contextStageDeps.loadFeatureManifests = origLoadFeatureManifests;
  _contextStageDeps.deriveProviderWeights = origDeriveProviderWeights;
  cleanupTempDir(tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeBundle(
  manifestOverrides: Partial<ContextManifest> = {},
  capturedScores: Record<string, number> = {},
  chunks: ContextBundle["chunks"] = [],
): ContextBundle {
  const manifest: ContextManifest = {
    requestId: "req-us004",
    stage: "context",
    totalBudgetTokens: 8_000,
    usedTokens: 100,
    includedChunks: Object.keys(capturedScores),
    excludedChunks: [],
    floorItems: [],
    digestTokens: 10,
    buildMs: 5,
    ...manifestOverrides,
  };
  return {
    pushMarkdown: "## Context\n\nus-004 bundle",
    pullTools: [],
    digest: "us004-digest",
    manifest,
    chunks,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: makeNaxConfig({
      context: {
        v2: { enabled: true },
        featureEngine: { budgetTokens: 8_000 },
      },
    }),
    rootConfig: {} as PipelineContext["rootConfig"],
    prd: { feature: "us-004-feature" } as PipelineContext["prd"],
    story: { id: "US-004" } as PipelineContext["story"],
    stories: [],
    routing: {} as PipelineContext["routing"],
    projectDir: tmpDir,
    workdir: tmpDir,
    hooks: {} as PipelineContext["hooks"],
    featureDir: join(tmpDir, "features", "us-004-feature"),
    sessionScratchDir: join(tmpDir, "sessions", "sess-us004"),
    sessionId: "sess-us004",
    ...overrides,
  } as PipelineContext;
}

/**
 * Captures the ContextRequest the contextStage hands to orchestrator.assemble().
 * The test asserts on the captured `request` to verify wiring.
 */
function captureContextRequest(): { captured: ContextRequest | null } {
  const ref: { captured: ContextRequest | null } = { captured: null };
  _contextStageDeps.createOrchestrator = mock(() =>
    makeContextOrchestrator({
      assemble: async (req: ContextRequest) => {
        ref.captured = req;
        return makeBundle();
      },
    }),
  );
  // Suppress scratch + digest I/O so the stage stays hermetic.
  _contextStageDeps.readDigest = async () => "";
  _contextStageDeps.writeDigest = async () => {};
  _contextStageDeps.uuid = () => "stub-uuid-us004-feature" as `${string}-${string}-${string}-${string}-${string}`;
  return ref;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC7: deriveProviderWeights is invoked exactly once when v2 is enabled
// ─────────────────────────────────────────────────────────────────────────────

describe("contextStage — deriveProviderWeights invocation (AC7)", () => {
  test("AC7: deriveProviderWeights is invoked once when contextStage.execute runs with v2 enabled", async () => {
    let callCount = 0;
    _contextStageDeps.loadFeatureManifests = (async () => {
      return [];
    }) as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.deriveProviderWeights = ((_manifests: ContextManifest[]) => {
      callCount++;
      return { "static-rules": 1.0, "code-neighbor": 0.9 };
    }) as typeof _contextStageDeps.deriveProviderWeights;
    captureContextRequest();

    await contextStage.execute(makeCtx());
    expect(callCount).toBe(1);
  });

  test("AC7 (single invocation): deriveProviderWeights sees the loaded manifests exactly once", async () => {
    let deriveInputBatches = 0;
    let lastBatch: ContextManifest[] = [];
    const sampleManifests: StoredContextManifest[] = [
      {
        featureId: "us-004-feature",
        stage: "context",
        path: "/tmp/sample.json",
        manifest: {
          requestId: "r1",
          stage: "context",
          totalBudgetTokens: 8_000,
          usedTokens: 100,
          includedChunks: ["c1"],
          excludedChunks: [],
          floorItems: [],
          digestTokens: 10,
          buildMs: 5,
        },
      },
    ];
    _contextStageDeps.loadFeatureManifests = (async () =>
      sampleManifests) as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.deriveProviderWeights = ((manifests: ContextManifest[]) => {
      deriveInputBatches++;
      lastBatch = manifests;
      return {};
    }) as typeof _contextStageDeps.deriveProviderWeights;
    captureContextRequest();

    await contextStage.execute(makeCtx());
    expect(deriveInputBatches).toBe(1);
    expect(lastBatch).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: low-weight run records a lower score than weight-1.0 run
// ─────────────────────────────────────────────────────────────────────────────

describe("contextStage — written manifest reflects lower weight (AC8)", () => {
  /**
   * AC8 is end-to-end: it must verify the production orchestrator + manifest
   * writing path persists a weighted score, not a fabricated stub.
   *
   * The context stage is invoked twice — once with deriveProviderWeights
   * returning 1.0 for the neighbor provider, once returning 0.2 — and the test
   * reads the score recorded on the real bundle the real ContextOrchestrator
   * produces. The bundle's chunks array is what buildManifest() walks to
   * populate chunkTokens / chunkProviders / chunkSummaries on the manifest;
   * a score field on the manifest would be populated from the same source.
   */
  test("AC8: low-weight run records a score strictly lower than weight-1.0 run for a non-floor provider", async () => {
    const chunkRecord = {
      id: "code-neighbor:file-x",
      kind: "neighbor" as const,
      scope: "feature" as const,
      role: ["implementer"] as Array<"implementer" | "reviewer" | "tdd" | "all">,
      content: "stub neighbor content",
      tokens: 100,
      rawScore: 0.5,
    };

    // Real-shaped provider that returns the test chunk. The orchestrator
    // stamps providerId onto the chunk before scoring.
    const provider: IContextProvider = {
      id: "code-neighbor",
      kind: "neighbor",
      fetch: async () => ({ chunks: [chunkRecord], pullTools: [] }),
    };

    // The "context" stage's provider allowlist (PHASE_3_IMPLEMENTATION in
    // stage-config.ts) includes several other provider IDs; the orchestrator
    // throws CONTEXT_UNKNOWN_PROVIDER_IDS for any allowlisted ID that has no
    // registered provider. Register empty stubs for the rest so only
    // "code-neighbor" contributes chunks.
    const emptyProviderIds = [
      "static-rules",
      "feature-context",
      "session-scratch",
      "git-history",
      "test-coverage",
      "tool-diagnostics", // US-002: registered in PHASE_3_IMPLEMENTATION
    ];
    const emptyProviders: IContextProvider[] = emptyProviderIds.map((id) => ({
      id,
      kind: "static",
      fetch: async () => ({ chunks: [], pullTools: [] }),
    }));

    _contextStageDeps.readDigest = async () => "";
    _contextStageDeps.writeDigest = async () => {};
    _contextStageDeps.uuid = () => "stub-uuid-us004-low-weight" as `${string}-${string}-${string}-${string}-${string}`;
    _contextStageDeps.loadFeatureManifests = (async () => []) as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.createOrchestrator = () => new ContextOrchestrator([provider, ...emptyProviders]);

    // Helper that runs the context stage with the supplied weight and returns
    // the production bundle (real orchestrator path — no fabrication).
    async function runWithWeight(weight: number): Promise<ContextBundle> {
      _contextStageDeps.deriveProviderWeights = (() => ({
        "code-neighbor": weight,
      })) as typeof _contextStageDeps.deriveProviderWeights;
      const ctx = makeCtx({ sessionId: `sess-weight-${weight}` });
      await contextStage.execute(ctx);
      if (!ctx.contextBundle) throw new Error("contextStage did not produce a bundle");
      return ctx.contextBundle;
    }

    // Run #1: weight 1.0 for the neighbor provider.
    const bundleUnitWeight = await runWithWeight(1.0);
    // The manifest records the chunk in includedChunks (so a downstream consumer
    // can find it via the per-chunk carrier fields the implementer adds).
    expect(bundleUnitWeight.manifest.includedChunks).toContain(chunkRecord.id);
    // AC8 requires the *written manifest* to carry the weighted score — the
    // manifest's chunkScores map (buildManifest walks bundle.chunks to
    // populate it, mirroring chunkTokens) is the persisted artifact, not the
    // in-memory bundle.chunks array.
    const scoreWithUnitWeight = bundleUnitWeight.manifest.chunkScores?.[chunkRecord.id];
    expect(scoreWithUnitWeight).toBeDefined();

    // Run #2: a lower (but not minScore-crossing) weight for the neighbor
    // provider. rawScore 0.5 * kindWeight 0.75 * weight must stay >= MIN_SCORE
    // (0.1) so the chunk remains included — AC6 (exclusion below minScore) is
    // covered separately; this test isolates the score-lowering effect.
    const bundleLowWeight = await runWithWeight(0.5);
    expect(bundleLowWeight.manifest.includedChunks).toContain(chunkRecord.id);
    const scoreWithLowWeight = bundleLowWeight.manifest.chunkScores?.[chunkRecord.id];
    expect(scoreWithLowWeight).toBeDefined();

    // AC8: under a low weight the written manifest records a strictly lower
    // score for the same chunk. This exercises ContextOrchestrator.assemble →
    // scoreChunks → scoreChunk → buildManifest's chunkScores carrier end to end.
    expect(scoreWithLowWeight as number).toBeLessThan(scoreWithUnitWeight as number);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: loadFeatureManifests is invoked with the pipeline context feature ID
// ─────────────────────────────────────────────────────────────────────────────

describe("contextStage — loadFeatureManifests invocation (AC10)", () => {
  test("AC10: loadFeatureManifests is invoked with the pipeline context feature ID", async () => {
    let capturedArgs: { projectDir?: string; featureId?: string } = {};
    _contextStageDeps.loadFeatureManifests = (async (opts?: { projectDir?: string; featureId?: string }) => {
      capturedArgs = { projectDir: opts?.projectDir, featureId: opts?.featureId };
      return [];
    }) as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.deriveProviderWeights = (() => ({})) as typeof _contextStageDeps.deriveProviderWeights;
    captureContextRequest();

    await contextStage.execute(makeCtx());
    expect(capturedArgs.featureId).toBe("us-004-feature");
  });

  test("AC10 (projectDir passed): loadFeatureManifests receives the pipeline context projectDir", async () => {
    let capturedProjectDir: string | undefined;
    _contextStageDeps.loadFeatureManifests = (async (opts?: { projectDir?: string }) => {
      capturedProjectDir = opts?.projectDir;
      return [];
    }) as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.deriveProviderWeights = (() => ({})) as typeof _contextStageDeps.deriveProviderWeights;
    captureContextRequest();

    await contextStage.execute(makeCtx());
    expect(capturedProjectDir).toBe(tmpDir);
  });

  test("AC7/AC10 (no featureDir): deriveProviderWeights still runs, keyed on v2 being enabled rather than a featureDir being set", async () => {
    let capturedFeatureId: string | undefined;
    let deriveCallCount = 0;
    _contextStageDeps.loadFeatureManifests = (async (opts?: { featureId?: string }) => {
      capturedFeatureId = opts?.featureId;
      return [];
    }) as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.deriveProviderWeights = (() => {
      deriveCallCount++;
      return {};
    }) as typeof _contextStageDeps.deriveProviderWeights;
    captureContextRequest();

    // No prd.feature and no featureDir — an "unattached" run (e.g. no-story session).
    await contextStage.execute(makeCtx({ prd: {} as PipelineContext["prd"], featureDir: undefined }));

    expect(deriveCallCount).toBe(1);
    expect(capturedFeatureId).toBe("_unattached");
  });
});
