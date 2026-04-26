/**
 * Tests for DebateRunner — US-002
 *
 * File: session-events.test.ts
 * Covers:
 * - JSONL events: debate:start, debate:proposal, debate:result, debate:fallback
 * - resolveDebaterModel used to pass resolved model to completeAs()
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps, resolveDebaterModel } from "../../../src/debate/session-helpers";
import type { DebateStageConfig, Debater } from "../../../src/debate/types";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { CallContext } from "../../../src/operations/types";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

function makeCallCtx(
  storyId: string,
  agentManager: ReturnType<typeof makeMockAgentManager>,
  config?: NaxConfig,
): CallContext {
  return {
    runtime: {
      agentManager,
      sessionManager: makeSessionManager(),
      configLoader: { current: () => config ?? DEFAULT_CONFIG, select: (_sel: unknown) => config ?? DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: config ?? DEFAULT_CONFIG, select: (_sel: unknown) => config ?? DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: config ?? DEFAULT_CONFIG, select: (_sel: unknown) => config ?? DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId,
    featureName: "test",
  };
}

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "claude-3-5-haiku-20241022" },
      { agent: "opencode", model: "gpt-4o-mini" },
      { agent: "gemini", model: "gemini-flash" },
    ],
    ...overrides,
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
});

// ─── JSONL log events ─────────────────────────────────────────────────────────

describe("DebateRunner.run() — JSONL log events", () => {
  test("emits debate:start event with storyId, stage, and debaters", async () => {
    const events: Array<{ stage: string; event: string; data: Record<string, unknown> }> = [];

    _debateSessionDeps.getSafeLogger = mock(() => ({
      info: (stage: string, event: string, data: Record<string, unknown>) => {
        events.push({ stage, event, data });
      },
      debug: () => {},
      warn: () => {},
      error: () => {},
    })) as never;

    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-LOG", agentManager),
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 1,
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("prompt");

    const startEvent = events.find((e) => e.event === "debate:start");
    expect(startEvent).toBeDefined();
    expect(startEvent?.data.storyId).toBe("US-LOG");
    expect(startEvent?.data.stage).toBe("plan");
    expect(Array.isArray(startEvent?.data.debaters)).toBe(true);
  });

  test("emits debate:proposal events after proposal round", async () => {
    const events: Array<{ stage: string; event: string; data: Record<string, unknown> }> = [];

    _debateSessionDeps.getSafeLogger = mock(() => ({
      info: (stage: string, event: string, data: Record<string, unknown>) => {
        events.push({ stage, event, data });
      },
      debug: () => {},
      warn: () => {},
      error: () => {},
    })) as never;

    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-LOG", agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 1,
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("prompt");

    const proposalEvents = events.filter((e) => e.event === "debate:proposal");
    expect(proposalEvents.length).toBe(2);
    expect(proposalEvents[0]?.data.storyId).toBe("US-LOG");
    expect(proposalEvents[0]?.data.debaterIndex).toBe(0);
  });

  test("emits debate:result event at the end of a successful debate", async () => {
    const events: Array<{ stage: string; event: string; data: Record<string, unknown> }> = [];

    _debateSessionDeps.getSafeLogger = mock(() => ({
      info: (stage: string, event: string, data: Record<string, unknown>) => {
        events.push({ stage, event, data });
      },
      debug: () => {},
      warn: () => {},
      error: () => {},
    })) as never;

    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-LOG", agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 1,
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("prompt");

    const resultEvent = events.find((e) => e.event === "debate:result");
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.data.storyId).toBe("US-LOG");
    expect(resultEvent?.data.outcome).toBeDefined();
  });

  test("emits debate:fallback warn event when only 1 debater succeeds", async () => {
    const warnings: Array<{ stage: string; event: string; data: Record<string, unknown> }> = [];

    _debateSessionDeps.getSafeLogger = mock(() => ({
      info: () => {},
      debug: () => {},
      warn: (stage: string, event: string, data: Record<string, unknown>) => {
        warnings.push({ stage, event, data });
      },
      error: () => {},
    })) as never;

    const agentManager = makeMockAgentManager({
      unavailableAgents: new Set(["missing"]),
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-LOG", agentManager),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing" }],
        rounds: 1,
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("prompt");

    const fallbackWarning = warnings.find((w) => w.event === "debate:fallback");
    expect(fallbackWarning).toBeDefined();
    expect(fallbackWarning?.data.storyId).toBe("US-LOG");
  });

  test("uses resolveDebaterModel to pass resolved model to completeAs()", async () => {
    const completeCalls: Array<{ agent: string; model: string | undefined }> = [];

    const config = {
      models: { claude: { fast: "claude-haiku-4-5" } },
      autoMode: { defaultAgent: "claude" },
    } as unknown as NaxConfig;

    const agentManager = makeMockAgentManager({
      completeAsFn: async (agentName, _prompt, opts) => {
        completeCalls.push({ agent: agentName, model: opts?.model });
        return { output: `output from ${agentName}`, costUsd: 0, source: "fallback" as const };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-LOG", agentManager, config),
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "claude" }],
        rounds: 1,
      }),
      config,
      workdir: "/tmp/work",
    });

    await runner.run("prompt");

    expect(completeCalls.every((c) => c.model === "claude-haiku-4-5")).toBe(true);
  });
});

// ─── resolveDebaterModel ─────────────────────────────────────────────────────

describe("resolveDebaterModel()", () => {
  test("returns debater.model as-is when no config provided", () => {
    const debater: Debater = { agent: "claude", model: "fast" };
    expect(resolveDebaterModel(debater)).toBe("fast");
  });

  test("resolves debater.model as tier name via config.models", () => {
    const debater: Debater = { agent: "claude", model: "fast" };
    const config = {
      models: { claude: { fast: "claude-haiku-4-5" } },
      autoMode: { defaultAgent: "claude" },
    } as unknown as NaxConfig;
    expect(resolveDebaterModel(debater, config)).toBe("claude-haiku-4-5");
  });

  test("resolves balanced tier via config.models", () => {
    const debater: Debater = { agent: "claude", model: "balanced" };
    const config = {
      models: { claude: { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-5" } },
      autoMode: { defaultAgent: "claude" },
    } as unknown as NaxConfig;
    expect(resolveDebaterModel(debater, config)).toBe("claude-sonnet-4-5");
  });

  test("falls back to raw model string when tier not found in config", () => {
    const debater: Debater = { agent: "claude", model: "custom-unknown-tier" };
    const config = {
      models: { claude: { fast: "claude-haiku-4-5" } },
      autoMode: { defaultAgent: "claude" },
    } as unknown as NaxConfig;
    expect(resolveDebaterModel(debater, config)).toBe("custom-unknown-tier");
  });

  test("defaults to fast tier when model is absent", () => {
    const debater: Debater = { agent: "claude" };
    const config = {
      models: { claude: { fast: "claude-haiku-4-5" } },
      autoMode: { defaultAgent: "claude" },
    } as unknown as NaxConfig;
    expect(resolveDebaterModel(debater, config)).toBe("claude-haiku-4-5");
  });

  test("returns undefined when model absent and config has no models", () => {
    const debater: Debater = { agent: "claude" };
    expect(resolveDebaterModel(debater, undefined)).toBeUndefined();
  });

  test("returns undefined when model absent and config.models is undefined", () => {
    const debater: Debater = { agent: "claude" };
    const config = {} as NaxConfig;
    expect(resolveDebaterModel(debater, config)).toBeUndefined();
  });

  test("falls back to defaultAgent model when agent has no entry in config.models", () => {
    const debater: Debater = { agent: "unknown-agent" };
    const config = {
      models: { claude: { fast: "claude-haiku-4-5" } },
      autoMode: { defaultAgent: "claude" },
    } as unknown as NaxConfig;
    expect(resolveDebaterModel(debater, config)).toBe("claude-haiku-4-5");
  });

  test("returns undefined when agent and defaultAgent both missing from config.models", () => {
    const debater: Debater = { agent: "unknown-agent" };
    const config = {
      models: {},
      autoMode: { defaultAgent: "also-missing" },
    } as unknown as NaxConfig;
    expect(resolveDebaterModel(debater, config)).toBeUndefined();
  });
});
