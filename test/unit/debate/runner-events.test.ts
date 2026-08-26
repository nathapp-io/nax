/**
 * Tests for DebateRunner — US-002
 *
 * Covers:
 * - JSONL events: debate:start, debate:proposal, debate:result, debate:fallback
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeMockAgentManager, makeMockCallContext, makeMockRuntime } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { DebateRunner } from "@/debate/runner";
import { _debateSessionDeps } from "@/debate/session-helpers";
import type { DebateStageConfig } from "@/debate/types";
import { Logger } from "@/logger";
import type { CallContext } from "@/operations/types";

function makeCallCtx(storyId: string, agentManager: ReturnType<typeof makeMockAgentManager>): CallContext {
  return makeMockCallContext({
    runtime: makeMockRuntime({ agentManager }),
    storyId,
  });
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

function makeCapturingLogger(
  infoEvents: Array<{ stage: string; event: string; data: Record<string, unknown> }>,
  warnEvents?: Array<{ stage: string; event: string; data: Record<string, unknown> }>,
): Logger {
  const logger = new Logger({ level: "silent" });
  logger.info = ((stage: string, event: string, data?: Record<string, unknown>) => {
    infoEvents.push({ stage, event, data: data ?? {} });
  }) as typeof logger.info;
  if (warnEvents) {
    logger.warn = ((stage: string, event: string, data?: Record<string, unknown>) => {
      warnEvents.push({ stage, event, data: data ?? {} });
    }) as typeof logger.warn;
  }
  return logger;
}

describe("DebateRunner.run() — JSONL log events", () => {
  test("emits debate:start event with storyId, stage, and debaters", async () => {
    const events: Array<{ stage: string; event: string; data: Record<string, unknown> }> = [];

    _debateSessionDeps.getSafeLogger = mock(() => makeCapturingLogger(events));

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

    _debateSessionDeps.getSafeLogger = mock(() => makeCapturingLogger(events));

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

    _debateSessionDeps.getSafeLogger = mock(() => makeCapturingLogger(events));

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
    const infoSink: Array<{ stage: string; event: string; data: Record<string, unknown> }> = [];

    _debateSessionDeps.getSafeLogger = mock(() => makeCapturingLogger(infoSink, warnings));

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
});
