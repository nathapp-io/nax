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
 * The current stub calls both deps (so AC7 and AC10 pass) but does NOT yet
 * apply weights in scoreChunk, so AC8 fails — the recorded score is the same
 * regardless of weight.
 *
 * Stub strategy:
 *   - loadFeatureManifests → returns an empty manifest list so deriveProviderWeights
 *     always has known input.
 *   - deriveProviderWeights → returns the test-supplied weights verbatim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ContextBundle, ContextRequest, ContextManifest, StoredContextManifest } from "@/context/engine";
import { _contextStageDeps, contextStage } from "@/pipeline/stages";
import type { PipelineContext } from "@/pipeline/types";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

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
    config: {
      context: {
        v2: { enabled: true },
        featureEngine: { budgetTokens: 8_000 },
      },
    } as unknown as PipelineContext["config"], // test-ratchet-allow: as-unknown-as
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
  _contextStageDeps.createOrchestrator = () =>
    ({
      async assemble(req: ContextRequest) {
        ref.captured = req;
        return makeBundle();
      },
      rebuildForAgent: () => makeBundle(),
    }) as unknown as ReturnType<typeof _contextStageDeps.createOrchestrator>; // test-ratchet-allow: as-unknown-as
  // Suppress scratch + digest I/O so the stage stays hermetic.
  _contextStageDeps.readDigest = async () => "";
  _contextStageDeps.writeDigest = async () => {};
  _contextStageDeps.uuid = () =>
    "stub-uuid-us004-feature" as `${string}-${string}-${string}-${string}-${string}`;
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
    _contextStageDeps.deriveProviderWeights = ((manifests: ContextManifest[]) => {
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
    _contextStageDeps.loadFeatureManifests = (async () => sampleManifests) as typeof _contextStageDeps.loadFeatureManifests;
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
   * Build a context stage stub that:
   *   - calls a real-shaped orchestrator that runs `scoreChunks` against the
   *     one chunk in the bundle so the resulting manifest records the actual
   *     score on the chunk id (not the placeholder `includedChunks.length`);
   *   - then returns a bundle whose manifest lists the chunk id with the
   *     scored value carried over.
   *
   * To keep the test hermetic, we run scoreChunks manually inside the stub
   * (not the real orchestrator) — this exercises the production scoring code
   * path against the weights supplied by `deriveProviderWeights`.
   */

  test("AC8: low-weight run records a score strictly lower than weight-1.0 run for a non-floor provider", async () => {
    const { scoreChunks } = await import("@/context/engine");
    const chunkRecord = {
      id: "code-neighbor:file-x",
      kind: "neighbor" as const,
      scope: "feature" as const,
      role: ["implementer"] as Array<"implementer" | "reviewer" | "tdd" | "all">,
      content: "stub neighbor content",
      tokens: 100,
      rawScore: 0.5,
      providerId: "code-neighbor",
    };

    // Stub the orchestrator so each contextStage.execute run scores the chunk
    // under whatever weight deriveProviderWeights hands back; the recorded
    // score on the bundle's chunks array is what the production orchestrator
    // would write. We mirror that into the manifest's includedChunks list so
    // the AC8 invariant ("records the chunk") holds end-to-end.
    function buildStubOrchestrator() {
      return async (req: ContextRequest) => {
        const weights = req.providerWeights;
        const [scored] = scoreChunks([chunkRecord], "implementer", undefined, weights);
        return makeBundle(
          { includedChunks: [scored.id] },
          { [scored.id]: scored.score },
          [
            {
              ...scored,
              providerId: chunkRecord.providerId,
            },
          ],
        );
      };
    }

    _contextStageDeps.readDigest = async () => "";
    _contextStageDeps.writeDigest = async () => {};
    _contextStageDeps.uuid = () =>
      "stub-uuid-us004-low-weight" as `${string}-${string}-${string}-${string}-${string}`;
    _contextStageDeps.loadFeatureManifests = (async () => []) as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.createOrchestrator = () =>
      ({
        assemble: buildStubOrchestrator(),
        rebuildForAgent: () => makeBundle(),
      }) as unknown as ReturnType<typeof _contextStageDeps.createOrchestrator>; // test-ratchet-allow: as-unknown-as

    // Run #1: deriveProviderWeights returns 1.0 for the neighbor provider.
    _contextStageDeps.deriveProviderWeights = (() => ({ "code-neighbor": 1.0 })) as typeof _contextStageDeps.deriveProviderWeights;
    const ctx1 = makeCtx({ sessionId: "sess-weight-1" });
    await contextStage.execute(ctx1);
    const bundleWithUnitWeight = ctx1.contextBundle;
    expect(bundleWithUnitWeight).toBeDefined();
    expect(bundleWithUnitWeight?.manifest.includedChunks).toContain(chunkRecord.id);
    const scoreWithUnitWeight = bundleWithUnitWeight?.chunks.find((c) => c.id === chunkRecord.id)?.score;
    expect(scoreWithUnitWeight).toBeDefined();

    // Run #2: deriveProviderWeights returns 0.2 for the neighbor provider.
    _contextStageDeps.deriveProviderWeights = (() => ({ "code-neighbor": 0.2 })) as typeof _contextStageDeps.deriveProviderWeights;
    const ctx2 = makeCtx({ sessionId: "sess-weight-low" });
    await contextStage.execute(ctx2);
    const bundleWithLowWeight = ctx2.contextBundle;
    expect(bundleWithLowWeight).toBeDefined();
    expect(bundleWithLowWeight?.manifest.includedChunks).toContain(chunkRecord.id);
    const scoreWithLowWeight = bundleWithLowWeight?.chunks.find((c) => c.id === chunkRecord.id)?.score;
    expect(scoreWithLowWeight).toBeDefined();

    // AC8: under a low weight the manifest records a strictly lower score.
    expect(scoreWithLowWeight as number).toBeLessThan(scoreWithUnitWeight as number);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: loadFeatureManifests is invoked with the pipeline context feature ID
// ─────────────────────────────────────────────────────────────────────────────

describe("contextStage — loadFeatureManifests invocation (AC10)", () => {
  test("AC10: loadFeatureManifests is invoked with the pipeline context feature ID", async () => {
    let capturedArgs: { projectDir?: string; featureId?: string } = {};
    _contextStageDeps.loadFeatureManifests = (async (projectDir: string, featureId?: string) => {
      capturedArgs = { projectDir, featureId };
      return [];
    }) as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.deriveProviderWeights = (() => ({})) as typeof _contextStageDeps.deriveProviderWeights;
    captureContextRequest();

    await contextStage.execute(makeCtx());
    expect(capturedArgs.featureId).toBe("us-004-feature");
  });

  test("AC10 (projectDir passed): loadFeatureManifests receives the pipeline context projectDir", async () => {
    let capturedProjectDir: string | undefined;
    _contextStageDeps.loadFeatureManifests = (async (projectDir: string) => {
      capturedProjectDir = projectDir;
      return [];
    }) as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.deriveProviderWeights = (() => ({})) as typeof _contextStageDeps.deriveProviderWeights;
    captureContextRequest();

    await contextStage.execute(makeCtx());
    expect(capturedProjectDir).toBe(tmpDir);
  });
});