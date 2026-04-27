/**
 * AC-18: StoryMetrics.context.providers populated from context manifests.
 *
 * Verifies that collectStoryMetrics() reads on-disk context manifests for the
 * story and aggregates per-provider metrics (tokensProduced, chunksProduced,
 * chunksKept, wallClockMs, timedOut, failed) across all pipeline stages.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _manifestStoreDeps } from "../../../src/context/engine/manifest-store";
import { collectStoryMetrics } from "../../../src/metrics/tracker";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { ContextManifest } from "../../../src/context/engine/types";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { PRD, UserStory } from "../../../src/prd";
import { makeStory } from "../../helpers";

const PROJECT_DIR = "/repo";
const FEATURE = "test-feature";
const STORY_ID = "US-001";

function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  const story = makeStory({ id: STORY_ID, status: "passed", passes: true, attempts: 1 });
  return {
    config: DEFAULT_CONFIG,
    prd: {
      project: "test",
      feature: FEATURE,
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    } satisfies PRD,
    story,
    stories: [story],
    routing: { complexity: "medium", modelTier: "balanced", testStrategy: "test-after", reasoning: "test" },
    workdir: PROJECT_DIR,
    projectDir: PROJECT_DIR,
    hooks: { hooks: {} },
    agentResult: { success: true, output: "", estimatedCostUsd: 0.01, durationMs: 5000 },
    ...overrides,
  } as unknown as PipelineContext;
}

function makeManifest(overrides?: Partial<ContextManifest>): ContextManifest {
  return {
    requestId: "req-001",
    stage: "execution",
    totalBudgetTokens: 8000,
    usedTokens: 500,
    includedChunks: [],
    excludedChunks: [],
    floorItems: [],
    digestTokens: 50,
    buildMs: 120,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock manifest store deps
// ─────────────────────────────────────────────────────────────────────────────

let origListFeatureDirs: typeof _manifestStoreDeps.listFeatureDirs;
let origListManifestFiles: typeof _manifestStoreDeps.listManifestFiles;
let origFileExists: typeof _manifestStoreDeps.fileExists;
let origReadFile: typeof _manifestStoreDeps.readFile;

function mockManifests(manifests: Record<string, ContextManifest>) {
  // manifests: key = "<featureId>/<stage>" → manifest
  _manifestStoreDeps.listFeatureDirs = async () => [FEATURE];
  _manifestStoreDeps.listManifestFiles = async () =>
    Object.keys(manifests)
      .filter((k) => k.startsWith(`${FEATURE}/`))
      .map((k) => `context-manifest-${k.split("/")[1]}.json`);
  _manifestStoreDeps.fileExists = async () => true;
  _manifestStoreDeps.readFile = async (path: string) => {
    const stage = path.replace(/.*context-manifest-/, "").replace(/\.json$/, "");
    const m = manifests[`${FEATURE}/${stage}`];
    return m ? JSON.stringify(m) : "{}";
  };
}

beforeEach(() => {
  origListFeatureDirs = _manifestStoreDeps.listFeatureDirs;
  origListManifestFiles = _manifestStoreDeps.listManifestFiles;
  origFileExists = _manifestStoreDeps.fileExists;
  origReadFile = _manifestStoreDeps.readFile;
});

afterEach(() => {
  _manifestStoreDeps.listFeatureDirs = origListFeatureDirs;
  _manifestStoreDeps.listManifestFiles = origListManifestFiles;
  _manifestStoreDeps.fileExists = origFileExists;
  _manifestStoreDeps.readFile = origReadFile;
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("collectStoryMetrics — AC-18 context.providers", () => {
  test("context is undefined when projectDir is absent", async () => {
    const ctx = makeCtx({ projectDir: undefined } as Partial<PipelineContext>);
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context).toBeUndefined();
  });

  test("context is undefined when no manifests exist", async () => {
    mockManifests({});
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context).toBeUndefined();
  });

  test("populates chunksProduced from providerResults.chunkCount", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 3, durationMs: 50, tokensProduced: 300 },
        ],
        includedChunks: ["static-rules:a:001", "static-rules:b:002", "static-rules:c:003"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["static-rules"]?.chunksProduced).toBe(3);
  });

  test("populates chunksKept by counting included chunks matching provider prefix", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 3, durationMs: 50, tokensProduced: 300 },
          { providerId: "git-history", status: "ok", chunkCount: 2, durationMs: 30, tokensProduced: 150 },
        ],
        includedChunks: [
          "static-rules:a:001",
          "static-rules:b:002",
          "git-history:c:003", // only 1 of 2 git-history chunks kept
        ],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["static-rules"]?.chunksKept).toBe(2);
    expect(metrics.context?.providers["git-history"]?.chunksKept).toBe(1);
  });

  test("populates wallClockMs from providerResults.durationMs", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "code-neighbor", status: "ok", chunkCount: 1, durationMs: 80, tokensProduced: 40 },
        ],
        includedChunks: ["code-neighbor:x:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["code-neighbor"]?.wallClockMs).toBe(80);
  });

  test("timedOut is true when any stage shows timeout for that provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "pull-tool", status: "timeout", chunkCount: 0, durationMs: 5000, tokensProduced: 0 },
        ],
        includedChunks: [],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["pull-tool"]?.timedOut).toBe(true);
    expect(metrics.context?.providers["pull-tool"]?.failed).toBe(false);
  });

  test("failed is true when any stage shows failed for that provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "plugin-rag", status: "failed", chunkCount: 0, durationMs: 20, tokensProduced: 0, error: "oops" },
        ],
        includedChunks: [],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["plugin-rag"]?.failed).toBe(true);
    expect(metrics.context?.providers["plugin-rag"]?.timedOut).toBe(false);
  });

  test("aggregates metrics across multiple stages for the same provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 2, durationMs: 40, tokensProduced: 200 },
        ],
        includedChunks: ["static-rules:a:001", "static-rules:b:002"],
      }),
      [`${FEATURE}/tdd-implementer`]: makeManifest({
        stage: "tdd-implementer",
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 2, durationMs: 35, tokensProduced: 200 },
        ],
        includedChunks: ["static-rules:a:001"], // only 1 kept in this stage
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    const p = metrics.context?.providers["static-rules"];
    expect(p?.chunksProduced).toBe(4); // 2 + 2
    expect(p?.chunksKept).toBe(3);     // 2 + 1
    expect(p?.wallClockMs).toBe(75);   // 40 + 35
    expect(p?.tokensProduced).toBe(400); // 200 + 200
  });

  test("tokensProduced sums across stages", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        providerResults: [
          { providerId: "code-neighbor", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 120 },
        ],
        includedChunks: ["code-neighbor:x:001"],
      }),
      [`${FEATURE}/verify`]: makeManifest({
        providerResults: [
          { providerId: "code-neighbor", status: "ok", chunkCount: 1, durationMs: 8, tokensProduced: 100 },
        ],
        includedChunks: ["code-neighbor:x:001"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.providers["code-neighbor"]?.tokensProduced).toBe(220);
  });
});
