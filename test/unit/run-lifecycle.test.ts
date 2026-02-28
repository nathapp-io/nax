/**
 * Tests for src/execution/run-lifecycle.ts
 *
 * Covers: RunLifecycle teardown critical paths
 */

import { describe, expect, it, mock } from "bun:test";
import type { NaxConfig } from "../../src/config";
import { RunLifecycle } from "../../src/execution/lifecycle";
import type { LoadedHooksConfig } from "../../src/hooks";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const mockConfig: NaxConfig = {
  autoMode: { defaultAgent: "claude" },
  routing: { strategy: "complexity", llm: { mode: "hybrid" } },
  execution: {
    maxStoriesPerFeature: 100,
    sessionTimeoutSeconds: 600,
    maxIterations: 50,
    costLimitUSD: 10.0,
  },
  models: {
    fast: { provider: "anthropic", name: "claude-3-haiku-20240307" },
    balanced: { provider: "anthropic", name: "claude-3-5-sonnet-20241022" },
    powerful: { provider: "anthropic", name: "claude-opus-4-20250514" },
  },
  tierOrder: [
    { tier: "fast", attempts: 3 },
    { tier: "balanced", attempts: 2 },
    { tier: "powerful", attempts: 1 },
  ],
  plugins: [],
  tdd: { enabled: true },
} as NaxConfig;

const mockHooks: LoadedHooksConfig = {
  "on-start": [],
  "on-story-start": [],
  "on-story-end": [],
  "on-error": [],
  "on-escalate": [],
  "on-end": [],
};

const mockStatusWriter = {
  setPrd: mock(() => {}),
  setRunStatus: mock(() => {}),
  setCurrentStory: mock(() => {}),
  update: mock(async () => {}),
};

// ─────────────────────────────────────────────────────────────────────────────
// RunLifecycle.teardown()
// ─────────────────────────────────────────────────────────────────────────────

describe("RunLifecycle.teardown", () => {
  it("calls plugin teardownAll during teardown", async () => {
    const teardownAllMock = mock(async () => {});
    const mockPluginRegistry = {
      teardownAll: teardownAllMock,
      plugins: [],
      getReporters: () => [],
    } as any;

    const lifecycle = new RunLifecycle(
      "/tmp/prd.json",
      "/tmp",
      mockConfig,
      mockHooks,
      "test-feature",
      false,
      false,
      // @ts-expect-error - partial mock
      mockStatusWriter,
      "run-001",
      new Date().toISOString(),
    );

    await lifecycle.teardown({
      runId: "run-001",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      prd: { feature: "test-feature", userStories: [] },
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 0,
      startTime: Date.now(),
      workdir: "/tmp",
      pluginRegistry: mockPluginRegistry,
      statusWriter: mockStatusWriter as any,
      iterations: 0,
    });

    expect(teardownAllMock).toHaveBeenCalledTimes(1);
  });

  it("updates status writer during teardown", async () => {
    const mockPluginRegistry = {
      teardownAll: async () => {},
      plugins: [],
      getReporters: () => [],
    } as any;

    const lifecycle = new RunLifecycle(
      "/tmp/prd.json",
      "/tmp",
      mockConfig,
      mockHooks,
      "test-feature",
      false,
      false,
      // @ts-expect-error - partial mock
      mockStatusWriter,
      "run-001",
      new Date().toISOString(),
    );

    await lifecycle.teardown({
      runId: "run-001",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      prd: { feature: "test-feature", userStories: [] },
      allStoryMetrics: [],
      totalCost: 1.5,
      storiesCompleted: 5,
      startTime: Date.now(),
      workdir: "/tmp",
      pluginRegistry: mockPluginRegistry,
      statusWriter: mockStatusWriter as any,
      iterations: 10,
    });

    expect(mockStatusWriter.setPrd).toHaveBeenCalled();
    expect(mockStatusWriter.setRunStatus).toHaveBeenCalled();
    expect(mockStatusWriter.update).toHaveBeenCalled();
  });
});
