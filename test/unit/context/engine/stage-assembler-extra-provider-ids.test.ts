import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ContextV2ConfigSchema } from "@/config/schemas";
import { _stageAssemblerDeps, assembleForStage } from "@/context/engine/stage-assembler";
import type { ContextBundle, ContextRequest } from "@/context/engine/types";
import type { PipelineContext } from "@/pipeline/types";
import { makeContextBundle, makeNaxConfig, makePRD, makeStory, makeTestContext } from "@test/helpers";

function makeCtx(extraProviderIds?: string[]): PipelineContext {
  const config = makeNaxConfig({
    context: {
      v2: {
        enabled: true,
        minScore: 0.1,
        deterministic: false,
        pluginProviders: [],
        pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5 },
        stages: extraProviderIds ? { review: { extraProviderIds } } : {},
      },
    },
  });
  const story = makeStory({ id: "US-001" });
  return makeTestContext({
    config,
    rootConfig: config,
    prd: makePRD({ feature: "test-feature", userStories: [] }),
    story,
    stories: [],
    projectDir: undefined,
    workdir: "/repo",
  });
}

function makeMockOrchestrator() {
  const captured: { request: ContextRequest | null } = { request: null };
  return {
    captured,
    orchestrator: {
      assemble: async (request: ContextRequest): Promise<ContextBundle> => {
        captured.request = request;
        return makeContextBundle({
          pushMarkdown: "",
          digest: "digest",
          manifest: {
            requestId: "req-1",
            stage: request.stage,
            totalBudgetTokens: request.budgetTokens,
            usedTokens: 0,
            includedChunks: [],
            excludedChunks: [],
            floorItems: [],
            digestTokens: 0,
            buildMs: 0,
          },
        });
      },
    },
  };
}

describe("assembleForStage — issue #662 extraProviderIds", () => {
  let origReaddir: typeof _stageAssemblerDeps.readdir;
  let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
  let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;

  beforeEach(() => {
    origReaddir = _stageAssemblerDeps.readdir;
    origReadDescriptor = _stageAssemblerDeps.readDescriptor;
    origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
    _stageAssemblerDeps.readdir = async () => {
      throw new Error("ENOENT");
    };
    _stageAssemblerDeps.readDescriptor = async () => null;
  });

  afterEach(() => {
    _stageAssemblerDeps.readdir = origReaddir;
    _stageAssemblerDeps.readDescriptor = origReadDescriptor;
    _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
  });

  test("passes configured extraProviderIds into the ContextRequest", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx(["my-symbol-graph", "team-rag"]), "review");

    expect(mock.captured.request?.extraProviderIds).toEqual(["my-symbol-graph", "team-rag"]);
  });

  test("defaults extraProviderIds to an empty array when the stage has no override", async () => {
    const mock = makeMockOrchestrator();
    _stageAssemblerDeps.createOrchestrator = () =>
      mock.orchestrator as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;

    await assembleForStage(makeCtx(), "review");

    expect(mock.captured.request?.extraProviderIds).toEqual([]);
  });

  test("schema accepts extraProviderIds and defaults it to [] per stage", () => {
    const parsed = ContextV2ConfigSchema.parse({
      stages: {
        review: { extraProviderIds: ["my-symbol-graph"] },
        verify: {},
      },
    });

    expect(parsed.stages.review?.extraProviderIds).toEqual(["my-symbol-graph"]);
    expect(parsed.stages.verify?.extraProviderIds).toEqual([]);
  });
});
