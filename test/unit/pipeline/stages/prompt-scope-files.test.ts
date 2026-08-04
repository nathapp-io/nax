/**
 * Unit tests for promptStage — Story: Resolve and thread complete scope files (AC-9).
 *
 * AC-9: When promptStage.execute(ctx) runs with context.v2.enabled true and a
 * stub provider, then its fetch request scopeFiles equals resolveScopeFiles(ctx)'s
 * result.
 *
 * promptStage threads `scopeFiles` into `assembleForStage` via
 * `StageAssembleOptions`. We hook `_stageAssemblerDeps.createOrchestrator` to
 * capture the ContextRequest handed to `orchestrator.assemble()`, then assert
 * the captured `scopeFiles`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ContextBundle, ContextRequest } from "@/context/engine";
import { _stageAssemblerDeps } from "@/context/engine";
import { _scopeFilesDeps, resolveScopeFiles } from "@/pipeline";
import { promptStage } from "@/pipeline/stages";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd/types";
import { makeNaxConfig, makeStory } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origCreateOrchestrator: typeof _stageAssemblerDeps.createOrchestrator;
let origReaddir: typeof _stageAssemblerDeps.readdir;
let origReadDescriptor: typeof _stageAssemblerDeps.readDescriptor;
let origResolveEffectiveRef: typeof _scopeFilesDeps.resolveEffectiveRef;
let origCollectDiffFileList: typeof _scopeFilesDeps.collectDiffFileList;

beforeEach(() => {
  origCreateOrchestrator = _stageAssemblerDeps.createOrchestrator;
  origReaddir = _stageAssemblerDeps.readdir;
  origReadDescriptor = _stageAssemblerDeps.readDescriptor;
  origResolveEffectiveRef = _scopeFilesDeps.resolveEffectiveRef;
  origCollectDiffFileList = _scopeFilesDeps.collectDiffFileList;
});

afterEach(() => {
  _stageAssemblerDeps.createOrchestrator = origCreateOrchestrator;
  _stageAssemblerDeps.readdir = origReaddir;
  _stageAssemblerDeps.readDescriptor = origReadDescriptor;
  _scopeFilesDeps.resolveEffectiveRef = origResolveEffectiveRef;
  _scopeFilesDeps.collectDiffFileList = origCollectDiffFileList;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePRD(story: UserStory): PRD {
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };
}

function makeCtx(story: UserStory): PipelineContext {
  const prd = makePRD(story);
  return {
    config: makeNaxConfig({ context: { v2: { enabled: true, pluginProviders: [] } } }),
    rootConfig: makeNaxConfig(),
    prd,
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "tdd-simple", reasoning: "" },
    projectDir: "/repo",
    workdir: "/repo",
    hooks: {} as PipelineContext["hooks"],
  } as unknown as PipelineContext;
}

/**
 * Capture the ContextRequest passed to orchestrator.assemble() by
 * assembleForStage inside promptStage.execute(). Suppresses scratch
 * directory reads to keep the test hermetic.
 */
function captureOrchestratorRequest(): { captured: ContextRequest | null } {
  const ref: { captured: ContextRequest | null } = { captured: null };
  _stageAssemblerDeps.createOrchestrator = () =>
    ({
      async assemble(req: ContextRequest) {
        ref.captured = req;
        return {
          pushMarkdown: "",
          digest: "stub",
          manifest: {
            requestId: "req-stub",
            stage: "single-session",
            totalBudgetTokens: 0,
            usedTokens: 0,
            includedChunks: [],
            excludedChunks: [],
            floorItems: [],
            digestTokens: 0,
            buildMs: 0,
          },
          packedChunks: [],
        } as unknown as ContextBundle;
      },
      rebuildForAgent: () => ({}) as unknown as ContextBundle,
    }) as unknown as ReturnType<typeof _stageAssemblerDeps.createOrchestrator>;
  _stageAssemblerDeps.readdir = async () => {
    throw new Error("ENOENT");
  };
  _stageAssemblerDeps.readDescriptor = async () => null;
  return ref;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-9
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage — scope files threading (AC-9)", () => {
  test("AC-9: fetch request scopeFiles equals resolveScopeFiles(ctx)'s result for declared sources only", async () => {
    const story = makeStory({
      contextFiles: ["src/a.ts", "src/b.ts"],
      expectedFiles: ["src/c.ts"],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const capture = captureOrchestratorRequest();

    const ctx = makeCtx(story);
    await promptStage.execute(ctx);

    const expected = await resolveScopeFiles(ctx);
    expect(capture.captured?.scopeFiles).toEqual(expected);
    expect(capture.captured?.scopeFiles).toBeDefined();
    expect(capture.captured?.scopeFiles?.length).toBeGreaterThan(0);
  });

  test("AC-9 (boundary): fetch request scopeFiles matches the resolver when diff is empty", async () => {
    const story = makeStory({
      contextFiles: ["src/declared.ts"],
      expectedFiles: [],
    });
    _scopeFilesDeps.resolveEffectiveRef = async () => "abc123";
    _scopeFilesDeps.collectDiffFileList = async () => [];

    const capture = captureOrchestratorRequest();

    const ctx = makeCtx(story);
    await promptStage.execute(ctx);

    const expected = await resolveScopeFiles(ctx);
    expect(capture.captured?.scopeFiles).toEqual(expected);
    expect(capture.captured?.scopeFiles).toEqual(["src/declared.ts"]);
  });
});
