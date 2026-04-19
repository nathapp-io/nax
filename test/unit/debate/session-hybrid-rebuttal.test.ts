/**
 * Tests for US-004-B: runHybrid() sequential rebuttal loop, session cleanup,
 * and result assembly.
 *
 * Covers ACs 1-10 for the rebuttal loop extension to runHybrid().
 * Proposal-phase behaviour is covered in session-hybrid.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { AgentAdapter, AgentRunOptions, CompleteOptions, CompleteResult } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const CLOSE_SESSION_PROMPT = "Close this debate session.";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRebuttalPrompt(prompt: string): boolean {
  return prompt.includes("## Your Task") && prompt.includes("You are debater");
}

function isClosePrompt(prompt: string): boolean {
  return prompt === CLOSE_SESSION_PROMPT;
}

function makeMockAdapter(
  name: string,
  options: {
    runFn?: (opts: AgentRunOptions) => Promise<ReturnType<AgentAdapter["run"]> extends Promise<infer R> ? R : never>;
    completeFn?: (prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
  } = {},
): AgentAdapter {
  return {
    name,
    displayName: name,
    binary: name,
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"],
      maxContextTokens: 100_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    },
    isInstalled: async () => true,
    run:
      options.runFn ??
      (async () => ({
        success: true,
        exitCode: 0,
        output: `output from ${name}`,
        rateLimited: false,
        durationMs: 1,
        estimatedCost: 0.01,
      })),
    buildCommand: () => [],
    buildAllowedEnv: () => ({}),
    plan: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    complete: options.completeFn ?? (async () => ({ output: "", costUsd: 0, source: "fallback" })),
  };
}

function makeHybridStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "stateful",
    mode: "hybrid",
    rounds: 1,
    timeoutSeconds: 60,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "fast" },
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
  _debateSessionDeps.getSafeLogger = mock(() => undefined);
});

afterEach(() => {
  _debateSessionDeps.getAgent = origGetAgent;
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

// ─── AC1: 2 debaters, rounds=1 → exactly 2 sequential rebuttal calls ─────────

describe("runHybrid() — sequential rebuttal call count with 2 debaters (AC1)", () => {
  test("with 2 debaters and rounds=1, rebuttal runStatefulTurn is called exactly 2 times", async () => {
    const rebuttalCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          if (isRebuttalPrompt(opts.prompt ?? "")) {
            rebuttalCalls.push(opts);
          }
          return {
            success: true,
            exitCode: 0,
            output: `output-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac1-count",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(rebuttalCalls).toHaveLength(2);
  });

  test("with 2 debaters and rounds=1, rebuttal calls happen in sequential debater order (0 then 1)", async () => {
    const rebuttalRoles: string[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          if (isRebuttalPrompt(opts.prompt ?? "")) {
            rebuttalRoles.push(opts.sessionRole ?? "");
          }
          return {
            success: true,
            exitCode: 0,
            output: `output-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac1-order",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(rebuttalRoles).toHaveLength(2);
    expect(rebuttalRoles[0]).toBe("debate-hybrid-0");
    expect(rebuttalRoles[1]).toBe("debate-hybrid-1");
  });
});

// ─── AC2: 3 debaters, rounds=2 → exactly 6 rebuttal calls ────────────────────

describe("runHybrid() — rebuttal call count with 3 debaters and 2 rounds (AC2)", () => {
  test("with 3 debaters and rounds=2, rebuttal runStatefulTurn is called exactly 6 times", async () => {
    const rebuttalCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          if (isRebuttalPrompt(opts.prompt ?? "")) {
            rebuttalCalls.push(opts);
          }
          return {
            success: true,
            exitCode: 0,
            output: `output-${name}-${rebuttalCalls.length}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac2",
      stage: "run",
      stageConfig: makeHybridStageConfig({
        rounds: 2,
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "opencode", model: "fast" },
          { agent: "gemini", model: "fast" },
        ],
      }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(rebuttalCalls).toHaveLength(6);
  });
});

// ─── AC3: each rebuttal prompt includes all successful proposal outputs ────────

describe("runHybrid() — rebuttal prompts include proposal outputs (AC3)", () => {
  test("each rebuttal turn prompt contains all successful proposal outputs", async () => {
    const rebuttalPrompts: string[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          if (isRebuttalPrompt(opts.prompt ?? "")) {
            rebuttalPrompts.push(opts.prompt ?? "");
          }
          return {
            success: true,
            exitCode: 0,
            output: `proposal-output-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac3",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(rebuttalPrompts).toHaveLength(2);
    for (const prompt of rebuttalPrompts) {
      expect(prompt).toContain("proposal-output-claude");
      expect(prompt).toContain("proposal-output-opencode");
    }
  });
});

// ─── AC4: round 2 prompts include round 1 rebuttal outputs ───────────────────

describe("runHybrid() — round 2 rebuttal prompts include round 1 outputs (AC4)", () => {
  test("round 2 rebuttal prompts contain all round 1 rebuttal outputs in previous-rebuttals section", async () => {
    let roundTracker = 0;
    const round1RebuttalOutputs: string[] = [];
    const round2Prompts: string[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          const prompt = opts.prompt ?? "";
          if (isRebuttalPrompt(prompt)) {
            roundTracker++;
            const output = `rebuttal-${name}-round-${roundTracker <= 2 ? 1 : 2}`;
            if (roundTracker <= 2) {
              round1RebuttalOutputs.push(output);
            } else {
              round2Prompts.push(prompt);
            }
            return {
              success: true,
              exitCode: 0,
              output,
              rateLimited: false,
              durationMs: 1,
              estimatedCost: 0.01,
            };
          }
          return {
            success: true,
            exitCode: 0,
            output: `proposal-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac4",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 2 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(round2Prompts).toHaveLength(2);
    for (const prompt of round2Prompts) {
      for (const r1output of round1RebuttalOutputs) {
        expect(prompt).toContain(r1output);
      }
    }
  });
});

// ─── AC5: failed rebuttal turn is skipped with warning ───────────────────────

describe("runHybrid() — failed rebuttal turn is skipped with warning (AC5)", () => {
  test("when one rebuttal turn throws, a warning is logged and the loop continues", async () => {
    const warnMessages: string[] = [];
    const mockLogger = {
      warn: (_stage: string, msg: string) => {
        warnMessages.push(msg);
      },
      info: () => {},
      debug: () => {},
      error: () => {},
    };
    _debateSessionDeps.getSafeLogger = mock(() => mockLogger as ReturnType<typeof _debateSessionDeps.getSafeLogger>);

    let rebuttalCallCount = 0;

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          const prompt = opts.prompt ?? "";
          if (isRebuttalPrompt(prompt)) {
            rebuttalCallCount++;
            if (name === "claude") {
              throw new Error("rebuttal failed for claude");
            }
          }
          return {
            success: true,
            exitCode: 0,
            output: `output-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac5",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    const result = await session.run("test prompt");

    // The loop must continue even when claude's rebuttal fails
    expect(rebuttalCallCount).toBe(2);
    // A warning must be emitted for the failed turn
    expect(warnMessages.some((m) => m.includes("rebuttal") || m.includes("failed") || m.includes("debate"))).toBe(true);
    // Overall run should still succeed
    expect(result.outcome).not.toBe("failed");
  });
});

// ─── AC6: rebuttal calls use same sessionRole as proposal and keepOpen:true

describe("runHybrid() — rebuttal calls use correct sessionRole and keepOpen (AC6)", () => {
  test("every rebuttal runStatefulTurn call uses the same sessionRole as the proposal round for that debater", async () => {
    const rebuttalCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          if (isRebuttalPrompt(opts.prompt ?? "")) {
            rebuttalCalls.push(opts);
          }
          return {
            success: true,
            exitCode: 0,
            output: `output-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac6-role",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(rebuttalCalls).toHaveLength(2);
    const roles = rebuttalCalls.map((c) => c.sessionRole);
    expect(roles).toContain("debate-hybrid-0");
    expect(roles).toContain("debate-hybrid-1");
  });

  test("every rebuttal runStatefulTurn call has keepOpen: true", async () => {
    const rebuttalCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          if (isRebuttalPrompt(opts.prompt ?? "")) {
            rebuttalCalls.push(opts);
          }
          return {
            success: true,
            exitCode: 0,
            output: `output-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac6-ksopen",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    expect(rebuttalCalls).toHaveLength(2);
    for (const call of rebuttalCalls) {
      expect(call.keepOpen).toBe(true);
    }
  });
});

// ─── AC7: closeStatefulSession called once per debater after normal completion

describe("runHybrid() — closeStatefulSession called after normal rebuttal loop (AC7)", () => {
  test("after the rebuttal loop completes normally, closeStatefulSession is called once per opened debater session", async () => {
    const closeCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          if (isClosePrompt(opts.prompt ?? "")) {
            closeCalls.push(opts);
          }
          return {
            success: true,
            exitCode: 0,
            output: `output-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac7",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    // One closeStatefulSession call per debater (2 debaters)
    expect(closeCalls).toHaveLength(2);
    const roles = closeCalls.map((c) => c.sessionRole);
    expect(roles).toContain("debate-hybrid-0");
    expect(roles).toContain("debate-hybrid-1");
  });
});

// ─── AC8: closeStatefulSession called even when all rebuttal turns fail ───────

describe("runHybrid() — closeStatefulSession called when rebuttal turns fail (AC8)", () => {
  test("when all rebuttal turns fail, closeStatefulSession is still called for all opened sessions", async () => {
    const closeCalls: AgentRunOptions[] = [];

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          const prompt = opts.prompt ?? "";
          if (isClosePrompt(prompt)) {
            closeCalls.push(opts);
            return {
              success: true,
              exitCode: 0,
              output: "",
              rateLimited: false,
              durationMs: 1,
              estimatedCost: 0,
            };
          }
          if (isRebuttalPrompt(prompt)) {
            throw new Error(`rebuttal failed for ${name}`);
          }
          return {
            success: true,
            exitCode: 0,
            output: `proposal-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.01,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac8",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    // Even though all rebuttal turns failed, close must still be called for each debater
    expect(closeCalls).toHaveLength(2);
  });
});

// ─── AC9: per-turn rebuttal costs summed into totalCostUsd ───────────────────

describe("runHybrid() — rebuttal costs accumulated in totalCostUsd (AC9)", () => {
  test("per-turn rebuttal costs are summed and reflected in totalCostUsd on the returned DebateResult", async () => {
    // Proposal cost: 2 × 0.10 = 0.20
    // Rebuttal cost: 2 × 0.05 = 0.10
    // Total expected: at least 0.30

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => {
          const prompt = opts.prompt ?? "";
          if (isClosePrompt(prompt)) {
            return { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 1, estimatedCost: 0 };
          }
          const cost = isRebuttalPrompt(prompt) ? 0.05 : 0.1;
          return {
            success: true,
            exitCode: 0,
            output: `output-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCost: cost,
          };
        },
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac9",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    const result = await session.run("test prompt");

    // 2 proposals × 0.10 + 2 rebuttals × 0.05 = 0.30
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0.29);
  });
});

// ─── AC10: DebateResult.rebuttals populated; debate:rebuttal-start emitted ───

describe("runHybrid() — DebateResult.rebuttals populated and debug event emitted (AC10)", () => {
  test("DebateResult.rebuttals contains one entry per successful rebuttal with correct debaterIndex, round, and output", async () => {
    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async (opts) => ({
          success: true,
          exitCode: 0,
          output: isRebuttalPrompt(opts.prompt ?? "") ? `rebuttal-output-${name}` : `proposal-${name}`,
          rateLimited: false,
          durationMs: 1,
          estimatedCost: 0.01,
        }),
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac10-rebuttals",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    const result = await session.run("test prompt");

    expect(result.rebuttals).toBeDefined();
    expect(result.rebuttals).toHaveLength(2);

    const outputs = (result.rebuttals ?? []).map((r) => r.output);
    expect(outputs).toContain("rebuttal-output-claude");
    expect(outputs).toContain("rebuttal-output-opencode");

    for (const rebuttal of result.rebuttals ?? []) {
      expect(rebuttal.round).toBe(1);
      expect(typeof rebuttal.debater).toBe("object");
    }
  });

  test("debate:rebuttal-start info event is emitted before each rebuttal turn", async () => {
    const infoEvents: Array<{ stage: string; event: string; data?: unknown }> = [];
    const mockLogger = {
      warn: () => {},
      info: (stage: string, event: string, data?: unknown) => {
        infoEvents.push({ stage, event, data });
      },
      debug: () => {},
      error: () => {},
    };
    _debateSessionDeps.getSafeLogger = mock(() => mockLogger as ReturnType<typeof _debateSessionDeps.getSafeLogger>);

    _debateSessionDeps.getAgent = mock((name: string) =>
      makeMockAdapter(name, {
        runFn: async () => ({
          success: true,
          exitCode: 0,
          output: `output-${name}`,
          rateLimited: false,
          durationMs: 1,
          estimatedCost: 0.01,
        }),
      }),
    );

    const session = new DebateSession({
      storyId: "US-004-B-ac10-event",
      stage: "run",
      stageConfig: makeHybridStageConfig({ rounds: 1 }),
      workdir: "/tmp/work",
      featureName: "feat",
      timeoutSeconds: 60,
    });

    await session.run("test prompt");

    const rebuttalStartEvents = infoEvents.filter((e) => e.stage === "debate:rebuttal-start");
    // One debate:rebuttal-start event per rebuttal turn (2 debaters × 1 round = 2)
    expect(rebuttalStartEvents).toHaveLength(2);

    // Each event must carry round and debaterIndex
    for (const evt of rebuttalStartEvents) {
      expect((evt.data as Record<string, unknown>)?.round).toBeDefined();
      expect((evt.data as Record<string, unknown>)?.debaterIndex).toBeDefined();
    }
  });
});
