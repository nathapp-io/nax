/**
 * Tests for DebateRunner.run() mode routing — US-002
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
import { type MockLogger, makeLogger, makeMockAgentManager, makeMockRuntime, makeSessionManager } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { DebateRunner } from "@/debate/runner";
import { _debateSessionDeps } from "@/debate/session-helpers";
import type { DebateMode, DebateStageConfig, SessionMode } from "@/debate/types";
import type { CallContext } from "@/operations/types";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";

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

function makeCallCtx(storyId: string, agentManager: ReturnType<typeof makeMockAgentManager>): CallContext {
  const runtime = makeMockRuntime({
    agentManager,
    sessionManager: makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    }),
    costAggregator: createNoOpCostAggregator(),
  });
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId,
    featureName: "test-feature",
  };
}

// ─── Test Setup ──────────────────────────────────────────────────────────────────

let logger: MockLogger;
let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  logger = makeLogger();
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;

  _debateSessionDeps.getSafeLogger = mock(() => logger);
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  logger.reset();
});

// ─── AC1: mode 'panel' + sessionMode 'one-shot' → runOneShot ──────────────────

describe("DebateRunner.run() mode routing — AC1: panel + one-shot", () => {
  test("with mode 'panel' and sessionMode 'one-shot', calls runOneShot", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, _p, _o) => ({
        output: `{"passed": true}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("test-story", agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        mode: "panel",
        sessionMode: "one-shot",
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const result = await runner.run("test prompt");
    expect(result.storyId).toBe("test-story");
  });
});

// ─── AC2: mode 'panel' + sessionMode 'stateful' → runStateful ────────────────

describe("DebateRunner.run() mode routing — AC2: panel + stateful", () => {
  test("with mode 'panel' and sessionMode 'stateful', calls runStateful", async () => {
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_name, _handle, _prompt) => ({
        output: `{"passed": true}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("test-story", agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        mode: "panel",
        sessionMode: "stateful",
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp",
      featureName: "test-feature",
    });

    const result = await runner.run("test prompt");
    expect(result.storyId).toBe("test-story");
  });
});

// ─── AC3: mode undefined + sessionMode 'one-shot' → runOneShot (backward compat) ──

describe("DebateRunner.run() mode routing — AC3: mode undefined defaults to panel", () => {
  test("with mode undefined and sessionMode 'one-shot', calls runOneShot (panel behavior)", async () => {
    const stageConfig = makeStageConfig({
      sessionMode: "one-shot",
    });
    // Explicitly clear mode to test backward compatibility — the runner reads
    // `this.stageConfig.mode ?? "panel"`, so an explicit undefined behaves like
    // an absent key.
    const withoutMode: { mode?: DebateMode } = stageConfig;
    withoutMode.mode = undefined;

    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, _p, _o) => ({
        output: `{"passed": true}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("test-story", agentManager),
      stage: "review",
      stageConfig,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const result = await runner.run("test prompt");
    expect(result.storyId).toBe("test-story");
  });
});

// ─── AC4: mode 'hybrid' + sessionMode 'stateful' → runHybrid ──────────────────

describe("DebateRunner.run() mode routing — AC4: hybrid + stateful", () => {
  test("with mode 'hybrid' and sessionMode 'stateful', calls runHybrid", async () => {
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_name, _handle, _prompt) => ({
        output: `{"passed": true}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("test-story", agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        mode: "hybrid",
        sessionMode: "stateful",
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp",
      featureName: "test-feature",
    });

    const result = await runner.run("test prompt");
    expect(result.storyId).toBe("test-story");
    expect(result.stage).toBe("review");
  });
});

// ─── AC5: mode 'hybrid' + sessionMode 'one-shot' → runOneShot + warning ────────

describe("DebateRunner.run() mode routing — AC5: hybrid + one-shot with fallback", () => {
  test("with mode 'hybrid' and sessionMode 'one-shot', calls runOneShot and logs warning", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, _p, _o) => ({
        output: `{"passed": true}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("test-story", agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        mode: "hybrid",
        sessionMode: "one-shot",
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const result = await runner.run("test prompt");

    expect(result.storyId).toBe("test-story");
    // Verify warning was logged
    const hybridWarning = logger.calls.find(
      (c) => c.level === "warn" && c.message.includes("hybrid mode requires sessionMode: stateful"),
    );
    expect(hybridWarning).toBeDefined();
  });
});

// ─── AC6: mode 'hybrid' + sessionMode undefined → runOneShot + warning ────────

describe("DebateRunner.run() mode routing — AC6: hybrid + undefined sessionMode with fallback", () => {
  test("with mode 'hybrid' and sessionMode undefined, calls runOneShot and logs warning", async () => {
    const stageConfig = makeStageConfig({
      mode: "hybrid",
    });
    // Clear sessionMode to test the undefined fallback path — the runner reads
    // `this.stageConfig.sessionMode ?? "one-shot"`, so an explicit undefined
    // behaves like an absent key.
    const withoutSessionMode: { sessionMode?: SessionMode } = stageConfig;
    withoutSessionMode.sessionMode = undefined;

    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, _p, _o) => ({
        output: `{"passed": true}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("test-story", agentManager),
      stage: "review",
      stageConfig,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    const result = await runner.run("test prompt");

    expect(result.storyId).toBe("test-story");
    // Verify warning was logged
    const hybridWarning = logger.calls.find(
      (c) => c.level === "warn" && c.message.includes("hybrid mode requires sessionMode: stateful"),
    );
    expect(hybridWarning).toBeDefined();
  });
});
