/**
 * Tests for DebateSession — US-002
 *
 * File: session-events.test.ts
 * Covers:
 * - JSONL events: debate:start, debate:proposal, debate:result, debate:fallback
 * - resolveDebaterModel used to pass resolved model to complete()
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps, resolveDebaterModel } from "../../../src/debate/session";
import type { DebateStageConfig, Debater } from "../../../src/debate/types";
import type { NaxConfig } from "../../../src/config";
import type { AgentAdapter, CompleteOptions, CompleteResult } from "../../../src/agents/types";

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function makeMockAdapter(
  name: string,
  options: {
    completeFn?: (prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
    isInstalledFn?: () => Promise<boolean>;
  } = {},
): AgentAdapter {
  return {
    name,
    displayName: name,
    binary: name,
    capabilities: {
      supportedTiers: ["fast"] as const,
      maxContextTokens: 100_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    },
    isInstalled: options.isInstalledFn ?? (async () => true),
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
    complete: options.completeFn ??
      (async (_p, _o) => ({
        output: `output from ${name}`,
        costUsd: 0,
        source: "fallback",
      })),
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

let origGetAgent: typeof _debateSessionDeps.getAgent;
let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetAgent = _debateSessionDeps.getAgent;
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
});

afterEach(() => {
  _debateSessionDeps.getAgent = origGetAgent;
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
});

// ─── JSONL log events ─────────────────────────────────────────────────────────

describe("DebateSession.run() — JSONL log events", () => {
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

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-LOG",
      stage: "plan",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 1,
      }),
    });

    await session.run("prompt");

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

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-LOG",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 1,
      }),
    });

    await session.run("prompt");

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

    _debateSessionDeps.getAgent = mock((name: string) => makeMockAdapter(name));

    const session = new DebateSession({
      storyId: "US-LOG",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "opencode" }],
        rounds: 1,
      }),
    });

    await session.run("prompt");

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

    _debateSessionDeps.getAgent = mock((name: string) => {
      if (name === "missing") return undefined;
      return makeMockAdapter(name);
    });

    const session = new DebateSession({
      storyId: "US-LOG",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "missing" }],
        rounds: 1,
      }),
    });

    await session.run("prompt");

    const fallbackWarning = warnings.find((w) => w.event === "debate:fallback");
    expect(fallbackWarning).toBeDefined();
    expect(fallbackWarning?.data.storyId).toBe("US-LOG");
  });

  test("uses resolveDebaterModel to pass resolved model to complete()", async () => {
    const completeCalls: Array<{ agent: string; model: string | undefined }> = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        completeFn: async (_prompt, opts) => {
          completeCalls.push({ agent: name, model: opts?.model });
          return `output from ${name}`;
        },
      }),
    );

    const config = {
      models: { claude: { fast: "claude-haiku-4-5" } },
      autoMode: { defaultAgent: "claude" },
    } as unknown as NaxConfig;

    const session = new DebateSession({
      storyId: "US-LOG",
      stage: "review",
      stageConfig: makeStageConfig({
        debaters: [{ agent: "claude" }, { agent: "claude" }],
        rounds: 1,
      }),
      config,
    });

    await session.run("prompt");

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
