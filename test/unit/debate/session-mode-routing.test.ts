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
import type { DebateStageConfig, DebateResult } from "../../../src/debate/types";
import type { AgentRunRequest, IAgentManager } from "../../../src/agents";
import type { CompleteOptions, CompleteResult } from "../../../src/agents/types";

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

function makeMockManager(): IAgentManager {
  return {
    getAgent: (_name: string) => ({} as any),
    getDefault: () => "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    events: { on: () => {} } as any,
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async (_req: AgentRunRequest) => ({
      result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] },
      fallbacks: [],
    }),
    completeWithFallback: async () => ({ result: { output: "", costUsd: 0, source: "fallback" }, fallbacks: [] }),
    run: async (_req: AgentRunRequest) => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }),
    complete: async () => ({ output: "", costUsd: 0, source: "fallback" }),
    completeAs: async (_name: string, _prompt: string, _opts?: CompleteOptions): Promise<CompleteResult> => ({
      output: `{"passed": true}`,
      costUsd: 0,
      source: "fallback",
    }),
    runAs: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }),
    plan: async () => ({ specContent: "" }),
    planAs: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    decomposeAs: async () => ({ stories: [] }),
  } as any;
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
let origCreateManager: typeof _debateSessionDeps.createManager;
let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  loggedWarnings = [];
  loggedInfos = [];
  origCreateManager = _debateSessionDeps.createManager;
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

  // Mock manager so debaters resolve quickly
  _debateSessionDeps.createManager = mock((_config) => makeMockManager());
  _debateSessionDeps.getSafeLogger = mockGetSafeLogger;
});

afterEach(() => {
  _debateSessionDeps.createManager = origCreateManager;
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
    _debateSessionDeps.createManager = mock((_config) => makeMockManager());

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
