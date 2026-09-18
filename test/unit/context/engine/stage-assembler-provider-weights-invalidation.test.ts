/**
 * PERF-1 — assembleForStage must not invalidate the provider-weights cache.
 *
 * writeContextManifest persists a manifest that carries no chunkEffectiveness,
 * the only field deriveProviderWeights reads. Invalidating here discarded the
 * weights loadOrGet had just derived without any fresher signal; invalidation
 * now lives in annotateManifestEffectiveness, where effectiveness is written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_TEST_ROUTING,
  makeContextBundle,
  makeContextOrchestrator,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTestContext,
  withDepsRestore,
} from "@test/helpers";
import { ProviderWeightsCache } from "@/context/engine";
import { _manifestStoreDeps } from "@/context/engine/manifest-store";
import { _stageAssemblerDeps, assembleForStage } from "@/context/engine/stage-assembler";
import type { PipelineContext } from "@/pipeline/types";

class SpyProviderWeightsCache extends ProviderWeightsCache {
  readonly invalidated: string[] = [];
  override async loadOrGet(): Promise<Record<string, number>> {
    return {};
  }
  override invalidate(featureId: string): void {
    this.invalidated.push(featureId);
  }
}

describe("assembleForStage — PERF-1: provider-weights cache is not invalidated", () => {
  withDepsRestore(_manifestStoreDeps);

  let origReaddir: typeof _stageAssemblerDeps.readdir;
  let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;
  let origLoadFeatureManifests: typeof _stageAssemblerDeps.loadFeatureManifests;
  let origDeriveProviderWeights: typeof _stageAssemblerDeps.deriveProviderWeights;

  beforeEach(() => {
    origReaddir = _stageAssemblerDeps.readdir;
    origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    origLoadFeatureManifests = _stageAssemblerDeps.loadFeatureManifests;
    origDeriveProviderWeights = _stageAssemblerDeps.deriveProviderWeights;
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT");
    };
    _stageAssemblerDeps.readDescriptor = async () => null;
    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeJson = async () => {};
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = origReaddir;
    _stageAssemblerDeps.readDescriptor = origReadDescriptor;
    _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
    _stageAssemblerDeps.loadFeatureManifests = origLoadFeatureManifests;
    _stageAssemblerDeps.deriveProviderWeights = origDeriveProviderWeights;
  });

  function makeCtx(): PipelineContext {
    const config = makeNaxConfig({
      context: { v2: { enabled: true, pluginProviders: [], deterministic: true } },
    });
    return makeTestContext({
      config,
      rootConfig: config,
      prd: makePRD({ feature: "test-feature", userStories: [] }),
      story: makeStory({ id: "US-001" }),
      stories: [],
      routing: { ...DEFAULT_TEST_ROUTING, agent: undefined, testStrategy: "test-after" },
      projectDir: "/repo",
      workdir: "/repo",
      hooks: { hooks: {} },
    });
  }

  test("does not call providerWeightsCache.invalidate after writing a stage manifest", async () => {
    _stageAssemblerDeps.createOrchestrator = () =>
      makeContextOrchestrator({
        assemble: async () =>
          makeContextBundle({
            pushMarkdown: "",
            digest: "abc",
            manifest: {
              requestId: "req-1",
              stage: "execution",
              totalBudgetTokens: 0,
              usedTokens: 0,
              includedChunks: [],
              excludedChunks: [],
              floorItems: [],
              digestTokens: 0,
              buildMs: 0,
            },
          }),
      });
    _stageAssemblerDeps.loadFeatureManifests = (async () => []) as typeof _stageAssemblerDeps.loadFeatureManifests;
    _stageAssemblerDeps.deriveProviderWeights = (() => ({})) as typeof _stageAssemblerDeps.deriveProviderWeights;

    const cache = new SpyProviderWeightsCache();

    const ctx = makeCtx();
    ctx.providerWeightsCache = cache;

    await assembleForStage(ctx, "execution");

    expect(cache.invalidated).toEqual([]);
  });
});
