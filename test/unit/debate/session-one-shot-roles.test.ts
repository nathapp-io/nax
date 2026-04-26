import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { CompleteOptions, CompleteResult } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    rounds: 1,
    debaters: [{ agent: "opencode" }, { agent: "opencode" }],
    timeoutSeconds: 60,
    ...overrides,
  };
}

function makeCallCtx(
  storyId: string,
  completeAsFn?: (agentName: string, prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>,
): CallContext {
  const agentManager = makeMockAgentManager({
    completeAsFn: completeAsFn ?? (async () => ({ output: '{"passed":true}', costUsd: 0, source: "fallback" as const })),
  });
  return {
    runtime: {
      agentManager,
      sessionManager: makeSessionManager(),
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId,
    featureName: "test",
  };
}

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }));
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

describe("DebateRunner.runPanelOneShot() proposal invocations", () => {
  test("calls completeAs for each debater in the proposal round", async () => {
    const agentCalls: string[] = [];

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-ROLE", async (agentName, _prompt, _opts) => {
        agentCalls.push(agentName);
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("prompt");

    // 2 debaters (opencode × 2) → 2 proposal calls
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls.every((a) => a === "opencode")).toBe(true);
  });

  test("calls completeAs for each debater in proposal AND critique rounds (rounds=2)", async () => {
    const callCount = { total: 0 };

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-ROLE", async (_agentName, _prompt, _opts) => {
        callCount.total++;
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("prompt");

    // 2 debaters × 2 rounds (proposal + critique) + synthesis call = ≥ 4
    expect(callCount.total).toBeGreaterThanOrEqual(4);
  });
});

// ─── P1: Proposal prompts include persona block ───────────────────────────────

describe("DebateRunner.runPanelOneShot() — persona injection in proposal round (P1)", () => {
  test("each debater receives a distinct persona block when autoPersona is true", async () => {
    const capturedPrompts: string[] = [];

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-P1", async (_agentName, prompt) => {
        capturedPrompts.push(prompt);
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 1,
        autoPersona: true,
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
        ],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("the task context");

    // Three proposal prompts captured
    expect(capturedPrompts).toHaveLength(3);

    // Each prompt contains "## Your Role"
    for (const prompt of capturedPrompts) {
      expect(prompt).toContain("## Your Role");
    }

    // Prompts are NOT all identical — personas differentiate them
    const unique = new Set(capturedPrompts);
    expect(unique.size).toBeGreaterThan(1);
  });

  test("proposal prompts do NOT contain persona block when autoPersona is false", async () => {
    const capturedPrompts: string[] = [];

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-P1-NO-PERSONA", async (_agentName, prompt) => {
        capturedPrompts.push(prompt);
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 1,
        autoPersona: false,
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
        ],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("the task context");

    for (const prompt of capturedPrompts) {
      expect(prompt).not.toContain("## Your Role");
    }
  });

  test("task context is preserved in proposal prompt alongside persona", async () => {
    const capturedPrompts: string[] = [];

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-P1-TASK", async (_agentName, prompt) => {
        capturedPrompts.push(prompt);
        return { output: '{"passed":true}', costUsd: 0, source: "fallback" as const };
      }),
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 1,
        autoPersona: true,
        debaters: [{ agent: "claude", model: "fast" }],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("UNIQUE_TASK_CONTENT_XYZ");

    expect(capturedPrompts[0]).toContain("UNIQUE_TASK_CONTENT_XYZ");
    expect(capturedPrompts[0]).toContain("## Your Role");
  });
});

// ─── P3: labeledProposals uses persona-aware label ────────────────────────────

describe("DebateRunner.runPanelOneShot() — labeledProposals persona label (P3)", () => {
  test("synthesis prompt labels proposals with persona when autoPersona is true", async () => {
    let capturedSynthesisPrompt = "";

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-P3", async (_agentName, prompt, opts) => {
        // The synthesis call is identified by sessionRole
        if (opts?.sessionRole === "synthesis") {
          capturedSynthesisPrompt = prompt;
        }
        return { output: "proposal output", costUsd: 0, source: "fallback" as const };
      }),
      stage: "plan",
      stageConfig: makeStageConfig({
        rounds: 1,
        sessionMode: "one-shot",
        autoPersona: true,
        resolver: { type: "synthesis", agent: "claude" },
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
        ],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("task");

    // Synthesis prompt should have persona-labeled proposals
    expect(capturedSynthesisPrompt).toContain("(challenger)");
    expect(capturedSynthesisPrompt).toContain("(pragmatist)");
    expect(capturedSynthesisPrompt).toContain("(completionist)");
  });

  test("synthesis prompt labels proposals without persona when autoPersona is false", async () => {
    let capturedSynthesisPrompt = "";

    const runner = new DebateRunner({
      ctx: makeCallCtx("US-P3-NO-PERSONA", async (_agentName, prompt, opts) => {
        if (opts?.sessionRole === "synthesis") {
          capturedSynthesisPrompt = prompt;
        }
        return { output: "proposal output", costUsd: 0, source: "fallback" as const };
      }),
      stage: "plan",
      stageConfig: makeStageConfig({
        rounds: 1,
        sessionMode: "one-shot",
        autoPersona: false,
        resolver: { type: "synthesis", agent: "claude" },
        debaters: [
          { agent: "claude", model: "fast" },
          { agent: "claude", model: "fast" },
        ],
      }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });

    await runner.run("task");

    // Should use agent name label only — no persona parens
    expect(capturedSynthesisPrompt).toContain("### Proposal claude");
    expect(capturedSynthesisPrompt).not.toContain("(challenger)");
  });
});
