/**
 * AC-25: Provider cost accounting
 *
 * A provider reporting costUsd on a chunk contributes to
 * StoryMetrics.context.providers[providerId].costUsd.
 * Run total is surfaced in the run completion log.
 *
 * Tests use _manifestStoreDeps injection to avoid disk I/O.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _manifestStoreDeps } from "../../../src/context/engine/manifest-store";
import type { ContextManifest } from "../../../src/context/engine/types";
import { collectStoryMetrics } from "../../../src/metrics/tracker";
import type { PipelineContext } from "../../../src/pipeline/types";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origListFeatureDirs: typeof _manifestStoreDeps.listFeatureDirs;
let origListManifestFiles: typeof _manifestStoreDeps.listManifestFiles;
let origFileExists: typeof _manifestStoreDeps.fileExists;
let origReadFile: typeof _manifestStoreDeps.readFile;

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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeManifest(providerResults: ContextManifest["providerResults"]): ContextManifest {
  return {
    requestId: "req-001",
    stage: "verify",
    totalBudgetTokens: 2000,
    usedTokens: 500,
    includedChunks: ["llm-provider:abc123"],
    excludedChunks: [],
    floorItems: [],
    digestTokens: 50,
    buildMs: 10,
    providerResults,
  };
}

function setupManifest(featureId: string, _storyId: string, manifest: ContextManifest) {
  _manifestStoreDeps.listFeatureDirs = async () => [featureId];
  _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-verify.json"];
  _manifestStoreDeps.fileExists = async () => true;
  _manifestStoreDeps.readFile = async () => JSON.stringify(manifest);
}

function makeCtx(id: string, featureId: string): PipelineContext {
  return {
    story: {
      id,
      title: "Test Story",
      description: "",
      acceptanceCriteria: [],
      status: "pending",
    },
    prd: { feature: featureId, userStories: [], project: "test", branchName: "main", createdAt: "", updatedAt: "" },
    config: { autoMode: { defaultAgent: "claude" } } as unknown as PipelineContext["config"],
    projectDir: "/repo",
    workdir: "/repo",
    routing: { tier: "balanced" },
    agentResult: { success: true, cost: 0 },
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-25: provider cost accounting in StoryMetrics", () => {
  test("costUsd is absent when provider reports no cost", async () => {
    setupManifest("feat-1", "US-001", makeManifest([
      { providerId: "git-history", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 200 },
    ]));
    const metrics = await collectStoryMetrics(makeCtx("US-001", "feat-1"), new Date().toISOString());
    const prov = metrics.context?.providers["git-history"];
    expect(prov).toBeDefined();
    expect(prov?.costUsd).toBeUndefined();
  });

  test("costUsd is aggregated when provider reports cost", async () => {
    setupManifest("feat-1", "US-001", makeManifest([
      { providerId: "llm-provider", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 200, costUsd: 0.0025 },
    ]));
    const metrics = await collectStoryMetrics(makeCtx("US-001", "feat-1"), new Date().toISOString());
    const prov = metrics.context?.providers["llm-provider"];
    expect(prov?.costUsd).toBeCloseTo(0.0025, 6);
  });

  test("costUsd accumulates across multiple manifest stages", async () => {
    const manifest1 = makeManifest([
      { providerId: "llm-provider", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 200, costUsd: 0.001 },
    ]);
    const manifest2: ContextManifest = { ...makeManifest([
      { providerId: "llm-provider", status: "ok", chunkCount: 1, durationMs: 12, tokensProduced: 150, costUsd: 0.002 },
    ]), stage: "execution" };

    let callCount = 0;
    _manifestStoreDeps.listFeatureDirs = async () => ["feat-1"];
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-verify.json", "context-manifest-execution.json"];
    _manifestStoreDeps.fileExists = async () => true;
    _manifestStoreDeps.readFile = async () => {
      return JSON.stringify(callCount++ === 0 ? manifest1 : manifest2);
    };

    const metrics = await collectStoryMetrics(makeCtx("US-001", "feat-1"), new Date().toISOString());
    expect(metrics.context?.providers["llm-provider"]?.costUsd).toBeCloseTo(0.003, 6);
  });

  test("costUsd is summed across multiple providers independently", async () => {
    setupManifest("feat-1", "US-001", makeManifest([
      { providerId: "provider-a", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 100, costUsd: 0.001 },
      { providerId: "provider-b", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 100, costUsd: 0.004 },
    ]));
    const metrics = await collectStoryMetrics(makeCtx("US-001", "feat-1"), new Date().toISOString());
    expect(metrics.context?.providers["provider-a"]?.costUsd).toBeCloseTo(0.001, 6);
    expect(metrics.context?.providers["provider-b"]?.costUsd).toBeCloseTo(0.004, 6);
  });

  test("costUsd zero is treated as absent (not set)", async () => {
    setupManifest("feat-1", "US-001", makeManifest([
      { providerId: "git-history", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 100, costUsd: 0 },
    ]));
    const metrics = await collectStoryMetrics(makeCtx("US-001", "feat-1"), new Date().toISOString());
    expect(metrics.context?.providers["git-history"]?.costUsd).toBeUndefined();
  });

  test("mixed providers: only LLM provider gets costUsd", async () => {
    setupManifest("feat-1", "US-001", makeManifest([
      { providerId: "git-history", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 100 },
      { providerId: "llm-provider", status: "ok", chunkCount: 1, durationMs: 20, tokensProduced: 300, costUsd: 0.005 },
    ]));
    const metrics = await collectStoryMetrics(makeCtx("US-001", "feat-1"), new Date().toISOString());
    expect(metrics.context?.providers["git-history"]?.costUsd).toBeUndefined();
    expect(metrics.context?.providers["llm-provider"]?.costUsd).toBeCloseTo(0.005, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator: costUsd aggregated from chunk.costUsd
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-25: orchestrator aggregates chunk costUsd into providerResults", () => {
  test("providerResults.costUsd is sum of chunk costUsd values", async () => {
    const { ContextOrchestrator, _orchestratorDeps } = await import("../../../src/context/engine/orchestrator");
    const orig = _orchestratorDeps.uuid;
    let seq = 0;
    _orchestratorDeps.uuid = () => `test-uuid-${++seq}` as `${string}-${string}-${string}-${string}-${string}`;
    _orchestratorDeps.now = () => Date.now();

    const provider = {
      id: "llm-provider",
      kind: "feature" as const,
      fetch: async () => ({
        chunks: [
          { id: "llm-provider:c1", kind: "feature" as const, scope: "feature" as const, role: ["implementer" as const], content: "chunk 1", tokens: 100, rawScore: 1.0, costUsd: 0.001 },
          { id: "llm-provider:c2", kind: "feature" as const, scope: "feature" as const, role: ["implementer" as const], content: "chunk 2", tokens: 100, rawScore: 1.0, costUsd: 0.002 },
        ],
      }),
    };

    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble({
      storyId: "US-001",
      repoRoot: "/project",
      packageDir: "/project",
      stage: "execution",
      role: "implementer",
      budgetTokens: 10_000,
      providerIds: ["llm-provider"],
    });

    const pr = bundle.manifest.providerResults?.find((p) => p.providerId === "llm-provider");
    expect(pr?.costUsd).toBeCloseTo(0.003, 6);

    _orchestratorDeps.uuid = orig;
  });

  test("providerResults.costUsd is absent when no chunks have costUsd", async () => {
    const { ContextOrchestrator, _orchestratorDeps } = await import("../../../src/context/engine/orchestrator");
    let seq = 0;
    _orchestratorDeps.uuid = () => `test-uuid-${++seq}` as `${string}-${string}-${string}-${string}-${string}`;

    const provider = {
      id: "git-history",
      kind: "feature" as const,
      fetch: async () => ({
        chunks: [
          { id: "git-history:c1", kind: "feature" as const, scope: "feature" as const, role: ["implementer" as const], content: "commit history", tokens: 200, rawScore: 1.0 },
        ],
      }),
    };

    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble({
      storyId: "US-001",
      repoRoot: "/project",
      packageDir: "/project",
      stage: "execution",
      role: "implementer",
      budgetTokens: 10_000,
      providerIds: ["git-history"],
    });

    const pr = bundle.manifest.providerResults?.find((p) => p.providerId === "git-history");
    expect(pr?.costUsd).toBeUndefined();
  });
});
