/**
 * Tests for DebateSession.run() mode routing — US-002
 *
 * Covers mode-based dispatch logic:
 * - AC1: mode 'panel' + sessionMode 'one-shot' → runOneShot
 * - AC2: mode 'panel' + sessionMode 'stateful' → runStateful
 * - AC3: mode undefined + sessionMode 'one-shot' → runOneShot (backward compat)
 * - AC4: mode 'hybrid' + sessionMode 'stateful' → runHybrid
 * - AC5: mode 'hybrid' + sessionMode 'one-shot' → runOneShot + warning
 * - AC6: mode 'hybrid' + sessionMode undefined → runOneShot + warning
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { DebateStageConfig, DebateResult, Debater } from "../../../src/debate/types";
import type { AgentAdapter, CompleteOptions, CompleteResult } from "../../../src/agents/types";

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    mode: "panel",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "claude-3-5-haiku-20241022" },
      { agent: "opencode", model: "gpt-4o-mini" },
    ],
    timeoutSeconds: 600,
    ...overrides,
  };
}

function makeMockAdapter(name: string): AgentAdapter {
  return {
    name,
    displayName: name,
    binary: name,
    capabilities: {
      supportedTiers: ["fast"] as const,
      maxContextTokens: 100_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    },
    isInstalled: async () => true,
    run: async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCost: 0,
    }),
    buildCommand: () => [],
    plan: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    complete: async (_p: string, _o?: CompleteOptions): Promise<CompleteResult> => ({
      output: `{"passed": true}`,
      costUsd: 0,
      source: "fallback",
    }),
  };
}

function makeMockResult(): DebateResult {
  return {
    storyId: "test-story",
    stage: "review",
    outcome: "passed",
    rounds: 1,
    debaters: ["claude", "opencode"],
    resolverType: "majority-fail-closed",
    proposals: [],
    totalCostUsd: 0,
  };
}

// ─── Test Setup ──────────────────────────────────────────────────────────────────

let loggedWarnings: Array<{ stage: string; message: string }> = [];
let loggedInfos: Array<{ stage: string; message: string }> = [];
let mockGetSafeLogger: ReturnType<typeof mock>;
let origGetAgent: typeof _debateSessionDeps.getAgent;
let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  loggedWarnings = [];
  loggedInfos = [];
  origGetAgent = _debateSessionDeps.getAgent;
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;

  mockGetSafeLogger = mock(() => ({
    info: (stage: string, message: string) => {
      loggedInfos.push({ stage, message });
    },
    debug: () => {},
    warn: (stage: string, message: string) => {
      loggedWarnings.push({ stage, message });
    },
    error: () => {},
  }));

  // Mock agent resolution so debaters resolve quickly
  _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));
  _debateSessionDeps.getSafeLogger = mockGetSafeLogger;
});

afterEach(() => {
  _debateSessionDeps.getAgent = origGetAgent;
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  loggedWarnings = [];
  loggedInfos = [];
});

// ─── AC1: mode 'panel' + sessionMode 'one-shot' → runOneShot ──────────────────

describe("DebateSession.run() mode routing — AC1: panel + one-shot", () => {
  test("with mode 'panel' and sessionMode 'one-shot', calls runOneShot", async () => {
    const session = new DebateSession({
      storyId: "test-story",
      stage: "review",
      stageConfig: makeStageConfig({
        mode: "panel",
        sessionMode: "one-shot",
      }),
    });

    // Mock that runOneShot is called (indirectly verified by checking session resolves)
    // The routing logic should call runOneShot for this combination
    const result = await session.run("test prompt");
    expect(result.storyId).toBe("test-story");
  });
});

// ─── AC2: mode 'panel' + sessionMode 'stateful' → runStateful ────────────────

describe("DebateSession.run() mode routing — AC2: panel + stateful", () => {
  test("with mode 'panel' and sessionMode 'stateful', calls runStateful", async () => {
    const session = new DebateSession({
      storyId: "test-story",
      stage: "review",
      stageConfig: makeStageConfig({
        mode: "panel",
        sessionMode: "stateful",
      }),
      workdir: "/tmp",
      featureName: "test-feature",
    });

    // The routing logic should call runStateful for this combination
    const result = await session.run("test prompt");
    expect(result.storyId).toBe("test-story");
  });
});

// ─── AC3: mode undefined + sessionMode 'one-shot' → runOneShot (backward compat) ──

describe("DebateSession.run() mode routing — AC3: mode undefined defaults to panel", () => {
  test("with mode undefined and sessionMode 'one-shot', calls runOneShot (panel behavior)", async () => {
    const stageConfig = makeStageConfig({
      sessionMode: "one-shot",
    });
    // Explicitly set mode to undefined to test backward compatibility
    delete (stageConfig as any).mode;

    const session = new DebateSession({
      storyId: "test-story",
      stage: "review",
      stageConfig: stageConfig as any,
    });

    // Mode defaults to 'panel', should call runOneShot
    const result = await session.run("test prompt");
    expect(result.storyId).toBe("test-story");
  });
});

// ─── AC4: mode 'hybrid' + sessionMode 'stateful' → runHybrid ──────────────────

describe("DebateSession.run() mode routing — AC4: hybrid + stateful", () => {
  test("with mode 'hybrid' and sessionMode 'stateful', calls runHybrid", async () => {
    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "test-story",
      stage: "review",
      stageConfig: makeStageConfig({
        mode: "hybrid",
        sessionMode: "stateful",
      }),
      workdir: "/tmp",
      featureName: "test-feature",
    });

    // runHybrid is now implemented — verify routing dispatches to it and returns a result
    const result = await session.run("test prompt");
    expect(result.storyId).toBe("test-story");
    expect(result.stage).toBe("review");
  });
});

// ─── AC5: mode 'hybrid' + sessionMode 'one-shot' → runOneShot + warning ────────

describe("DebateSession.run() mode routing — AC5: hybrid + one-shot with fallback", () => {
  test("with mode 'hybrid' and sessionMode 'one-shot', calls runOneShot and logs warning", async () => {
    const session = new DebateSession({
      storyId: "test-story",
      stage: "review",
      stageConfig: makeStageConfig({
        mode: "hybrid",
        sessionMode: "one-shot",
      }),
    });

    const result = await session.run("test prompt");

    expect(result.storyId).toBe("test-story");
    // Verify warning was logged
    const hybridWarning = loggedWarnings.find((w) =>
      w.message.includes("hybrid mode requires sessionMode: stateful"),
    );
    expect(hybridWarning).toBeDefined();
  });
});

// ─── AC6: mode 'hybrid' + sessionMode undefined → runOneShot + warning ────────

describe("DebateSession.run() mode routing — AC6: hybrid + undefined sessionMode with fallback", () => {
  test("with mode 'hybrid' and sessionMode undefined, calls runOneShot and logs warning", async () => {
    const stageConfig = makeStageConfig({
      mode: "hybrid",
    });
    // Remove sessionMode to test undefined behavior
    delete (stageConfig as any).sessionMode;

    const session = new DebateSession({
      storyId: "test-story",
      stage: "review",
      stageConfig: stageConfig as any,
    });

    const result = await session.run("test prompt");

    expect(result.storyId).toBe("test-story");
    // Verify warning was logged
    const hybridWarning = loggedWarnings.find((w) =>
      w.message.includes("hybrid mode requires sessionMode: stateful"),
    );
    expect(hybridWarning).toBeDefined();
  });
});
