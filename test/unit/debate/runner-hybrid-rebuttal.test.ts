import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import { type DebateStageConfig } from "../../../src/debate/types";
import * as callModule from "../../../src/operations";
import type { DebateStatefulInput } from "../../../src/operations/debate-stateful";
import type { CallContext } from "../../../src/operations/types";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager } from "../../helpers";

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

function makeCallCtx(
  agentManager: ReturnType<typeof makeMockAgentManager>,
  sessionManager: ReturnType<typeof makeSessionManager>,
  storyId = "US-test",
): CallContext {
  const config = makeNaxConfig({
    debate: {
      maxConcurrentDebaters: 3,
    },
  });

  return {
    runtime: {
      agentManager,
      sessionManager,
      configLoader: { current: () => config, select: (_sel: unknown) => config } as never,
      packages: { resolve: () => ({ config, select: (_sel: unknown) => config }) } as never,
      signal: undefined,
    } as never,
    packageView: { config, select: (_sel: unknown) => config } as never,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId,
    featureName: "feat",
  };
}

function makeRunner(
  stageConfigOverrides: Partial<DebateStageConfig> = {},
  storyId = "US-test",
): DebateRunner {
  const agentManager = makeMockAgentManager();
  const sessionManager = makeSessionManager({
    openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
    closeSession: mock(async () => {}),
    nameFor: mock((req) => req.role ?? ""),
  });
  const ctx = makeCallCtx(agentManager, sessionManager, storyId);

  return new DebateRunner({
    ctx,
    stage: "run",
    stageConfig: makeHybridStageConfig(stageConfigOverrides),
    config: DEFAULT_CONFIG,
    workdir: "/tmp/work",
    featureName: "feat",
    timeoutSeconds: 60,
    sessionManager,
  });
}

function isRebuttalTurn(input: DebateStatefulInput): boolean {
  return input.proposePrompt.includes("## Proposals");
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

describe("DebateRunner hybrid rebuttal", () => {
  test("with 2 debaters and rounds=1, the public runner launches 2 rebuttal turns in debater order", async () => {
    const runner = makeRunner();
    const rebuttalRoles: string[] = [];

    spyOn(callModule, "callOp").mockImplementation(async (callCtx, _op, input: DebateStatefulInput) => {
      if (!isRebuttalTurn(input)) {
        input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      }

      rebuttalRoles.push(callCtx.sessionOverride?.role ?? "");
      return { success: true, rebut: `rebuttal-${input.index}` };
    });

    await runner.run("test prompt");

    expect(rebuttalRoles).toEqual(["debate-hybrid-0", "debate-hybrid-1"]);
  });

  test("with 3 debaters and rounds=2, the public runner launches 6 rebuttal turns", async () => {
    const runner = makeRunner({
      rounds: 2,
      debaters: [
        { agent: "claude", model: "fast" },
        { agent: "opencode", model: "fast" },
        { agent: "gemini", model: "fast" },
      ],
    });
    const rebuttalPrompts: string[] = [];

    spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: DebateStatefulInput) => {
      if (!isRebuttalTurn(input)) {
        input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      }

      rebuttalPrompts.push(input.proposePrompt);
      return {
        success: true,
        rebut: input.proposePrompt.includes("## Previous Rebuttals") ? `rebut-2-${input.index}` : `rebut-1-${input.index}`,
      };
    });

    await runner.run("test prompt");

    expect(rebuttalPrompts).toHaveLength(6);
  });

  test("each rebuttal prompt contains all successful proposal outputs", async () => {
    const runner = makeRunner();
    const rebuttalPrompts: string[] = [];

    spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: DebateStatefulInput) => {
      if (!isRebuttalTurn(input)) {
        input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      }

      rebuttalPrompts.push(input.proposePrompt);
      return { success: true, rebut: `rebuttal-${input.index}` };
    });

    await runner.run("test prompt");

    expect(rebuttalPrompts).toHaveLength(2);
    for (const prompt of rebuttalPrompts) {
      expect(prompt).toContain("proposal-0");
      expect(prompt).toContain("proposal-1");
    }
  });

  test("round 2 rebuttal prompts contain round 1 outputs in the previous-rebuttals section", async () => {
    const runner = makeRunner({ rounds: 2 });
    const roundTwoPrompts: string[] = [];

    spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: DebateStatefulInput) => {
      if (!isRebuttalTurn(input)) {
        input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      }

      if (input.proposePrompt.includes("## Previous Rebuttals")) {
        roundTwoPrompts.push(input.proposePrompt);
        return { success: true, rebut: `rebut-2-${input.index}` };
      }

      return { success: true, rebut: `rebut-1-${input.index}` };
    });

    await runner.run("test prompt");

    expect(roundTwoPrompts).toHaveLength(2);
    for (const prompt of roundTwoPrompts) {
      expect(prompt).toContain("rebut-1-0");
      expect(prompt).toContain("rebut-1-1");
    }
  });

  test("when one rebuttal turn fails, the runner skips it and still returns a debate result", async () => {
    const runner = makeRunner();

    spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: DebateStatefulInput) => {
      if (!isRebuttalTurn(input)) {
        input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      }

      if (input.index === 0) {
        throw new Error("rebuttal failed");
      }

      return { success: true, rebut: "rebuttal-1" };
    });

    const result = await runner.run("test prompt");

    expect(result.storyId).toBe("US-test");
    expect(result.rebuttals).toEqual([{ debater: { agent: "opencode", model: "fast" }, round: 1, output: "rebuttal-1" }]);
  });

  test("proposal and rebuttal turns for the same debater reuse the same session role", async () => {
    const runner = makeRunner({ rounds: 2 });
    const rolesByDebater = new Map<number, string[]>();

    spyOn(callModule, "callOp").mockImplementation(async (callCtx, _op, input: DebateStatefulInput) => {
      const roles = rolesByDebater.get(input.index) ?? [];
      roles.push(callCtx.sessionOverride?.role ?? "");
      rolesByDebater.set(input.index, roles);

      if (!isRebuttalTurn(input)) {
        input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      }

      return {
        success: true,
        rebut: input.proposePrompt.includes("## Previous Rebuttals") ? `rebut-2-${input.index}` : `rebut-1-${input.index}`,
      };
    });

    await runner.run("test prompt");

    expect(rolesByDebater.get(0)).toEqual(["debate-hybrid-0", "debate-hybrid-0", "debate-hybrid-0"]);
    expect(rolesByDebater.get(1)).toEqual(["debate-hybrid-1", "debate-hybrid-1", "debate-hybrid-1"]);
  });

  test("per-turn costs accumulated through callOp are reflected in totalCostUsd", async () => {
    const runner = makeRunner();

    spyOn(callModule, "callOp").mockImplementation(async (callCtx, _op, input: DebateStatefulInput) => {
      callCtx.onCostAccumulated?.(isRebuttalTurn(input) ? 0.05 : 0.1);

      if (!isRebuttalTurn(input)) {
        input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      }

      return { success: true, rebut: `rebuttal-${input.index}` };
    });

    const result = await runner.run("test prompt");

    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0.29);
  });

  test("DebateResult.rebuttals contains one entry per successful rebuttal turn", async () => {
    const runner = makeRunner();

    spyOn(callModule, "callOp").mockImplementation(async (_callCtx, _op, input: DebateStatefulInput) => {
      if (!isRebuttalTurn(input)) {
        input.proposalBarriers[0]?.resolve(`proposal-${input.index}`);
        return { success: true, rebut: `proposal-${input.index}` };
      }

      return { success: true, rebut: `rebuttal-${input.index}` };
    });

    const result = await runner.run("test prompt");

    expect(result.rebuttals).toEqual([
      { debater: { agent: "claude", model: "fast" }, round: 1, output: "rebuttal-0" },
      { debater: { agent: "opencode", model: "fast" }, round: 1, output: "rebuttal-1" },
    ]);
  });
});
