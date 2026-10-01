/**
 * Metrics Tracker — StoryMetrics field accounting: provider cost (AC-25),
 * fullSuiteGatePassed (RL-005), and runtimeCrashes (BUG-070).
 *
 * AC-25: A provider reporting costUsd on a chunk contributes to
 * StoryMetrics.context.providers[providerId].costUsd. Run total is surfaced
 * in the run completion log. Tests use _manifestStoreDeps injection to avoid
 * disk I/O.
 *
 * RL-005: fullSuiteGatePassed is tracked per story — true only for
 * three-session-tdd / three-session-tdd-lite when ctx.fullSuiteGatePassed is
 * set; test-after and tdd-simple always produce false, and batch metrics are
 * never TDD-gated.
 *
 * BUG-070: story metrics track how many times a story was retried due to a
 * Bun runtime crash (RUNTIME_CRASH verify status), separately from
 * intentional escalations. nax#1707 follow-up: the tally lives on the
 * run-scoped runtime.runtimeCrashRetries map, written by handleTierEscalation,
 * which survives the per-attempt PipelineContext rebuild.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_TEST_ROUTING,
  makeMockRuntime,
  makeNaxConfig,
  makePRD as makeProviderPRD,
  makeStory as makeProviderStory,
  makeTestContext,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _manifestStoreDeps } from "@/context/engine/manifest-store";
import type { ContextManifest } from "@/context/engine/types";
import { collectStoryMetrics } from "@/metrics/tracker";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origListFeatureDirs: typeof _manifestStoreDeps.listFeatureDirs;
let origListManifestFiles: typeof _manifestStoreDeps.listManifestFiles;
let origReadFile: typeof _manifestStoreDeps.readFile;

beforeEach(() => {
  origListFeatureDirs = _manifestStoreDeps.listFeatureDirs;
  origListManifestFiles = _manifestStoreDeps.listManifestFiles;
  origReadFile = _manifestStoreDeps.readFile;
});

afterEach(() => {
  _manifestStoreDeps.listFeatureDirs = origListFeatureDirs;
  _manifestStoreDeps.listManifestFiles = origListManifestFiles;
  _manifestStoreDeps.readFile = origReadFile;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test description",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "passed",
    passes: true,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePRD(story: UserStory): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };
}

const WORKDIR = `/tmp/nax-tracker-gate-test-${randomUUID()}`;
const CRASH_WORKDIR = `/tmp/nax-test-metrics-${randomUUID()}`;
const WORKDIR_BATCH = `/tmp/nax-test-metrics-batch-${randomUUID()}`;
const STORY_START_TIME = "2026-03-10T10:00:00.000Z";

function makeCtx(
  story: UserStory,
  routingOverrides?: Partial<PipelineContext["routing"]>,
  ctxOverrides?: Partial<PipelineContext>,
): PipelineContext {
  return Object.assign(
    makeTestContext({
      config: { ...DEFAULT_CONFIG } as NaxConfig,
      prd: makePRD(story),
      story,
      stories: [story],
      routing: {
        complexity: "medium",
        modelTier: "balanced",
        testStrategy: "three-session-tdd",
        reasoning: "test",
        ...routingOverrides,
      },
      workdir: WORKDIR,
    }),
    {
      agentResult: {
        success: true,
        output: "",
        estimatedCostUsd: 0.01,
        durationMs: 5000,
      },
      runtime: makeMockRuntime(),
    },
    ctxOverrides ?? {},
  );
}

function makeContext(story: UserStory, overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    config: makeNaxConfig(),
    prd: makePRD(story),
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test",
    },
    workdir: CRASH_WORKDIR,
    hooks: { hooks: {} },
    runtime: makeMockRuntime(),
    ...overrides,
  } as PipelineContext;
}

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
  _manifestStoreDeps.readFile = async () => JSON.stringify(manifest);
}

function makeProviderCtx(id: string, featureId: string): PipelineContext {
  return Object.assign(
    makeTestContext({
      story: makeProviderStory({ id, title: "Test Story" }),
      prd: makeProviderPRD({ feature: featureId, project: "test", branchName: "main" }),
      config: makeNaxConfig({ agent: { default: "claude" } }),
      projectDir: "/repo",
      workdir: "/repo",
      routing: { ...DEFAULT_TEST_ROUTING, modelTier: "balanced" },
    }),
    { agentResult: { success: true, cost: 0 }, runtime: makeMockRuntime() },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-25: provider cost accounting in StoryMetrics
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-25: provider cost accounting in StoryMetrics", () => {
  test("costUsd is absent when provider reports no cost", async () => {
    setupManifest(
      "feat-1",
      "US-001",
      makeManifest([{ providerId: "git-history", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 200 }]),
    );
    const metrics = await collectStoryMetrics(makeProviderCtx("US-001", "feat-1"), new Date().toISOString());
    const prov = metrics.context?.providers["git-history"];
    expect(prov).toBeDefined();
    expect(prov?.costUsd).toBeUndefined();
  });

  test("costUsd is aggregated when provider reports cost", async () => {
    setupManifest(
      "feat-1",
      "US-001",
      makeManifest([
        {
          providerId: "llm-provider",
          status: "ok",
          chunkCount: 1,
          durationMs: 10,
          tokensProduced: 200,
          costUsd: 0.0025,
        },
      ]),
    );
    const metrics = await collectStoryMetrics(makeProviderCtx("US-001", "feat-1"), new Date().toISOString());
    const prov = metrics.context?.providers["llm-provider"];
    expect(prov?.costUsd).toBeCloseTo(0.0025, 6);
  });

  test("costUsd accumulates across multiple manifest stages", async () => {
    const manifest1 = makeManifest([
      { providerId: "llm-provider", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 200, costUsd: 0.001 },
    ]);
    const manifest2: ContextManifest = {
      ...makeManifest([
        {
          providerId: "llm-provider",
          status: "ok",
          chunkCount: 1,
          durationMs: 12,
          tokensProduced: 150,
          costUsd: 0.002,
        },
      ]),
      stage: "execution",
    };

    let callCount = 0;
    _manifestStoreDeps.listFeatureDirs = async () => ["feat-1"];
    _manifestStoreDeps.listManifestFiles = async () => [
      "context-manifest-verify.json",
      "context-manifest-execution.json",
    ];
    _manifestStoreDeps.readFile = async () => {
      return JSON.stringify(callCount++ === 0 ? manifest1 : manifest2);
    };

    const metrics = await collectStoryMetrics(makeProviderCtx("US-001", "feat-1"), new Date().toISOString());
    expect(metrics.context?.providers["llm-provider"]?.costUsd).toBeCloseTo(0.003, 6);
  });

  test("costUsd is summed across multiple providers independently", async () => {
    setupManifest(
      "feat-1",
      "US-001",
      makeManifest([
        { providerId: "provider-a", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 100, costUsd: 0.001 },
        { providerId: "provider-b", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 100, costUsd: 0.004 },
      ]),
    );
    const metrics = await collectStoryMetrics(makeProviderCtx("US-001", "feat-1"), new Date().toISOString());
    expect(metrics.context?.providers["provider-a"]?.costUsd).toBeCloseTo(0.001, 6);
    expect(metrics.context?.providers["provider-b"]?.costUsd).toBeCloseTo(0.004, 6);
  });

  test("costUsd zero is treated as absent (not set)", async () => {
    setupManifest(
      "feat-1",
      "US-001",
      makeManifest([
        { providerId: "git-history", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 100, costUsd: 0 },
      ]),
    );
    const metrics = await collectStoryMetrics(makeProviderCtx("US-001", "feat-1"), new Date().toISOString());
    expect(metrics.context?.providers["git-history"]?.costUsd).toBeUndefined();
  });

  test("mixed providers: only LLM provider gets costUsd", async () => {
    setupManifest(
      "feat-1",
      "US-001",
      makeManifest([
        { providerId: "git-history", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 100 },
        {
          providerId: "llm-provider",
          status: "ok",
          chunkCount: 1,
          durationMs: 20,
          tokensProduced: 300,
          costUsd: 0.005,
        },
      ]),
    );
    const metrics = await collectStoryMetrics(makeProviderCtx("US-001", "feat-1"), new Date().toISOString());
    expect(metrics.context?.providers["git-history"]?.costUsd).toBeUndefined();
    expect(metrics.context?.providers["llm-provider"]?.costUsd).toBeCloseTo(0.005, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator: costUsd aggregated from chunk.costUsd
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-25: orchestrator aggregates chunk costUsd into providerResults", () => {
  test("providerResults.costUsd is sum of chunk costUsd values", async () => {
    const { ContextOrchestrator, _orchestratorDeps } = await import("@/context/engine/orchestrator");
    const orig = _orchestratorDeps.uuid;
    let seq = 0;
    _orchestratorDeps.uuid = () => `test-uuid-${++seq}` as `${string}-${string}-${string}-${string}-${string}`;
    _orchestratorDeps.now = () => Date.now();

    const provider = {
      id: "llm-provider",
      kind: "feature" as const,
      fetch: async () => ({
        chunks: [
          {
            id: "llm-provider:c1",
            kind: "feature" as const,
            scope: "feature" as const,
            role: ["implementer" as const],
            content: "chunk 1",
            tokens: 100,
            rawScore: 1.0,
            costUsd: 0.001,
          },
          {
            id: "llm-provider:c2",
            kind: "feature" as const,
            scope: "feature" as const,
            role: ["implementer" as const],
            content: "chunk 2",
            tokens: 100,
            rawScore: 1.0,
            costUsd: 0.002,
          },
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
    const { ContextOrchestrator, _orchestratorDeps } = await import("@/context/engine/orchestrator");
    let seq = 0;
    _orchestratorDeps.uuid = () => `test-uuid-${++seq}` as `${string}-${string}-${string}-${string}-${string}`;

    const provider = {
      id: "git-history",
      kind: "feature" as const,
      fetch: async () => ({
        chunks: [
          {
            id: "git-history:c1",
            kind: "feature" as const,
            scope: "feature" as const,
            role: ["implementer" as const],
            content: "commit history",
            tokens: 200,
            rawScore: 1.0,
          },
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

// ─────────────────────────────────────────────────────────────────────────────
// RL-005: fullSuiteGatePassed field
// ─────────────────────────────────────────────────────────────────────────────

describe("StoryMetrics type - fullSuiteGatePassed field", () => {
  test("StoryMetrics includes fullSuiteGatePassed field", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd" }, { fullSuiteGatePassed: true });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect("fullSuiteGatePassed" in metrics).toBe(true);
  });
});

describe("collectStoryMetrics - fullSuiteGatePassed for TDD strategies", () => {
  test("returns true for three-session-tdd when ctx.fullSuiteGatePassed is true", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd" }, { fullSuiteGatePassed: true });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(true);
  });

  test("returns true for three-session-tdd-lite when ctx.fullSuiteGatePassed is true", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd-lite" }, { fullSuiteGatePassed: true });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(true);
  });

  test("returns false for three-session-tdd when ctx.fullSuiteGatePassed is false", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd" }, { fullSuiteGatePassed: false });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });

  test("returns false for three-session-tdd when ctx.fullSuiteGatePassed is undefined", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "three-session-tdd" });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });
});

describe("collectStoryMetrics - fullSuiteGatePassed always false for non-TDD strategies", () => {
  test("returns false for test-after even when ctx.fullSuiteGatePassed is true", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "test-after" }, { fullSuiteGatePassed: true });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });

  test("returns false for tdd-simple even when ctx.fullSuiteGatePassed is true", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "tdd-simple" }, { fullSuiteGatePassed: true });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });

  test("returns false for test-after when ctx.fullSuiteGatePassed is false", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "test-after" }, { fullSuiteGatePassed: false });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });

  test("returns false for tdd-simple when ctx.fullSuiteGatePassed is false", async () => {
    const story = makeStory();
    const ctx = makeCtx(story, { testStrategy: "tdd-simple" }, { fullSuiteGatePassed: false });

    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.fullSuiteGatePassed).toBe(false);
  });
});

describe("collectBatchMetrics - fullSuiteGatePassed always false", () => {
  test("batch metrics always have fullSuiteGatePassed: false", async () => {
    const { collectBatchMetrics } = await import("@/metrics/tracker");
    const story1 = makeStory({ id: "US-001" });
    const story2 = makeStory({ id: "US-002" });
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story1, story2],
    };
    const ctx = Object.assign(
      makeTestContext({
        config: { ...DEFAULT_CONFIG } as NaxConfig,
        prd,
        story: story1,
        stories: [story1, story2],
        routing: {
          complexity: "medium",
          modelTier: "balanced",
          testStrategy: "three-session-tdd",
          reasoning: "test",
        },
        workdir: WORKDIR,
      }),
      {
        agentResult: {
          success: true,
          output: "",
          estimatedCostUsd: 0.02,
          durationMs: 10000,
        },
        fullSuiteGatePassed: true,
        runtime: makeMockRuntime(),
      },
    );

    const metrics = collectBatchMetrics(ctx, new Date().toISOString());

    for (const m of metrics) {
      expect(m.fullSuiteGatePassed).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-070: runtimeCrashes counter
// ─────────────────────────────────────────────────────────────────────────────

describe("collectStoryMetrics - runtimeCrashes field", () => {
  test("runtimeCrashes is 0 when no crashes occurred", async () => {
    const story = makeStory();
    const ctx = makeContext(story);

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).toBe(0);
  });

  test("runtimeCrashes reflects the run-scoped crash tally", async () => {
    const story = makeStory({ status: "passed", passes: true });
    const ctx = makeContext(story);
    ctx.runtime.runtimeCrashRetries.set(story.id, 2);

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).toBe(2);
  });

  test("runtimeCrashes is 1 for a single crash retry", async () => {
    const story = makeStory({ status: "passed", passes: true });
    const ctx = makeContext(story);
    ctx.runtime.runtimeCrashRetries.set(story.id, 1);

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).toBe(1);
  });

  test("runtimeCrashes is independent of story.escalations count", async () => {
    // A story can have 2 escalations (tier changes) AND 3 crash retries — tracked separately
    const story = makeStory({
      status: "passed",
      passes: true,
      escalations: [
        { fromTier: "fast", toTier: "balanced", reason: "tests-failing", timestamp: new Date().toISOString() },
        { fromTier: "balanced", toTier: "thorough", reason: "tests-failing", timestamp: new Date().toISOString() },
      ],
    });
    const ctx = makeContext(story);
    ctx.runtime.runtimeCrashRetries.set(story.id, 3);

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).toBe(3);
    expect(metrics.attempts).toBeGreaterThan(0); // escalations still recorded
  });

  test("runtimeCrashes defaults to 0 when the story never crashed", async () => {
    const story = makeStory();
    const ctx = makeContext(story);

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).not.toBeUndefined();
    expect(metrics.runtimeCrashes).toBe(0);
  });
});

describe("StoryMetrics type — runtimeCrashes field", () => {
  test("collectStoryMetrics output includes runtimeCrashes as a number", async () => {
    const story = makeStory();
    const ctx = makeContext(story);

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    // Must be a number (0 when no crashes), not undefined or string
    expect(typeof metrics.runtimeCrashes).toBe("number");
  });
});

describe("collectBatchMetrics - runtimeCrashes per story", () => {
  test("batch stories with no recorded crash retries report 0", async () => {
    const { collectBatchMetrics } = await import("@/metrics/tracker");

    const stories = [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })];
    const ctx = Object.assign(
      makeTestContext({
        config: makeNaxConfig(),
        prd: makePRD(stories[0]),
        story: stories[0],
        stories,
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "test",
        },
        workdir: WORKDIR_BATCH,
      }),
      {
        agentResult: { success: true, estimatedCostUsd: 0.01, durationMs: 1000 },
        runtime: makeMockRuntime(),
      },
    );

    const batchMetrics = collectBatchMetrics(ctx, STORY_START_TIME);

    for (const m of batchMetrics) {
      expect(m.runtimeCrashes).toBe(0);
    }
  });
});
