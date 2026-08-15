/**
 * US-003 AC12: createDefaultOrchestrator registers PriorRunFailureProvider
 *
 * Mirrors the US-002 ToolDiagnosticsProvider factory-registration coverage.
 * The provider is registered unconditionally — no branching on a feature flag.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NaxConfig } from "@/config";
import {
  createDefaultOrchestrator,
  _codeNeighborDeps,
  _gitHistoryDeps,
  PriorRunFailureProvider,
  _priorRunFailureDeps,
} from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import type { UserStory } from "@/prd";
import { makeNaxConfig } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(): UserStory {
  return {
    id: "US-003",
    title: "Test story",
    description: "desc",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    attempts: 1,
    escalations: [],
  };
}

function makeConfig(): NaxConfig {
  return makeNaxConfig({
    context: {
      v2: {
        enabled: true,
        minScore: 0.1,
        deterministic: false,
        pluginProviders: [],
        stages: {},
        pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5 },
        rules: { allowLegacyClaudeMd: true },
        session: { retentionDays: 7, archiveOnFeatureArchive: true },
        staleness: { enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 },
        providers: {
          historyScope: "package",
          neighborScope: "package",
          crossPackageDepth: 1,
        },
      },
    },
  });
}

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-003",
    featureId: "test-feature",
    repoRoot: "/repo",
    packageDir: "/repo/packages/pkg-a",
    stage: "rectify",
    role: "implementer",
    budgetTokens: 8000,
    touchedFiles: ["src/auth.ts"],
    storyScratchDirs: [],
    agentId: "claude",
    ...overrides,
  } as ContextRequest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps for restoration
// ─────────────────────────────────────────────────────────────────────────────

let origGitWithTimeout: typeof _gitHistoryDeps.gitWithTimeout;
let origCodeNeighborReadFile: typeof _codeNeighborDeps.readFile;
let origCodeNeighborGlob: typeof _codeNeighborDeps.glob;
let origCodeNeighborDetectLanguage: typeof _codeNeighborDeps.detectLanguage;
let origLoadRunMetrics: typeof _priorRunFailureDeps.loadRunMetrics;

beforeEach(() => {
  origGitWithTimeout = _gitHistoryDeps.gitWithTimeout;
  origCodeNeighborReadFile = _codeNeighborDeps.readFile;
  origCodeNeighborGlob = _codeNeighborDeps.glob;
  origCodeNeighborDetectLanguage = _codeNeighborDeps.detectLanguage;
  origLoadRunMetrics = _priorRunFailureDeps.loadRunMetrics;
  // Suppress real FS/git calls; emit empty metrics.
  _gitHistoryDeps.gitWithTimeout = async () => ({ stdout: "", exitCode: 0, stderr: "" });
  _codeNeighborDeps.readFile = async () => "";
  _codeNeighborDeps.glob = () => ({ files: [], truncated: false });
  _codeNeighborDeps.detectLanguage = async () => undefined;
  _priorRunFailureDeps.loadRunMetrics = async () => [];
});

afterEach(() => {
  _gitHistoryDeps.gitWithTimeout = origGitWithTimeout;
  _codeNeighborDeps.readFile = origCodeNeighborReadFile;
  _codeNeighborDeps.glob = origCodeNeighborGlob;
  _codeNeighborDeps.detectLanguage = origCodeNeighborDetectLanguage;
  _priorRunFailureDeps.loadRunMetrics = origLoadRunMetrics;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12: PriorRunFailureProvider registration
// ─────────────────────────────────────────────────────────────────────────────

describe("createDefaultOrchestrator — PriorRunFailureProvider registration (US-003 AC12)", () => {
  test("AC12: PriorRunFailureProvider is registered — providerResults include id 'prior-run-failure' after assemble", async () => {
    const orchestrator = createDefaultOrchestrator(makeStory(), makeConfig());
    const request = makeRequest({
      providerIds: ["prior-run-failure"],
      storyScratchDirs: [],
    });
    const bundle = await orchestrator.assemble(request);

    const pfResult = bundle.manifest.providerResults?.find((p) => p.providerId === "prior-run-failure");
    expect(pfResult).toBeDefined();
    expect(pfResult?.providerId).toBe("prior-run-failure");
  });

  test("AC12: PriorRunFailureProvider is registered unconditionally — construction never throws", () => {
    expect(() => createDefaultOrchestrator(makeStory(), makeConfig())).not.toThrow();
  });

  test("PriorRunFailureProvider.fetch() emits chunks when metrics record a failure for the requested story", async () => {
    _priorRunFailureDeps.loadRunMetrics = async () => [
      {
        runId: "run-1",
        feature: "f",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        totalCost: 0,
        totalStories: 1,
        storiesCompleted: 0,
        storiesFailed: 1,
        totalDurationMs: 0,
        stories: [
          {
            storyId: "US-003",
            complexity: "medium",
            modelTier: "balanced",
            modelUsed: "claude-sonnet-4",
            attempts: 2,
            finalTier: "balanced",
            success: false,
            cost: 0,
            durationMs: 0,
            firstPassSuccess: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:01:00.000Z",
            failingTestFiles: ["src/foo.test.ts"],
          },
        ],
      },
    ];

    const orchestrator = createDefaultOrchestrator(makeStory(), makeConfig());
    const bundle = await orchestrator.assemble(
      makeRequest({ providerIds: ["prior-run-failure"], storyScratchDirs: [] }),
    );
    const pfResult = bundle.manifest.providerResults?.find((p) => p.providerId === "prior-run-failure");
    expect(pfResult?.status).toBe("ok");
    expect(pfResult?.chunkCount).toBeGreaterThan(0);
  });

  test("US-003 sanity: PriorRunFailureProvider class is the one wired into the orchestrator (smoke)", () => {
    expect(new PriorRunFailureProvider().id).toBe("prior-run-failure");
    expect(new PriorRunFailureProvider().kind).toBe("prior-failure");
  });
});
