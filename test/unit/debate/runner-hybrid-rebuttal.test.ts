import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeLogger,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
  withDepsRestore,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { DebateRunner } from "@/debate/runner";
import { _hybridDeps } from "@/debate/runner-hybrid";
import { _debateSessionDeps } from "@/debate/session-helpers";
import type { DebateStageConfig } from "@/debate/types";
import type { DebateHybridInput } from "@/operations/debate-hybrid";
import type { CallContext } from "@/operations/types";

function installCallOp(impl: typeof _hybridDeps.callOp) {
  const spy = mock(impl);
  _hybridDeps.callOp = spy;
  return spy;
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

function makeCallCtx(
  agentManager: ReturnType<typeof makeMockAgentManager>,
  sessionManager: ReturnType<typeof makeSessionManager>,
  storyId = "US-test",
): CallContext {
  const _config = makeNaxConfig({
    debate: {
      maxConcurrentDebaters: 3,
    },
  });

  const runtime = makeMockRuntime({ agentManager, sessionManager });
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId,
    featureName: "feat",
  };
}

function makeRunner(stageConfigOverrides: Partial<DebateStageConfig> = {}, storyId = "US-test"): DebateRunner {
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

/** Simulate what hybridDebaterOp.hopBody does: resolve shared barriers, return last rebuttal. */
function makeHybridOpMock(outputFn?: (index: number, round: number) => string) {
  return async (_callCtx: CallContext, _op: unknown, input: DebateHybridInput) => {
    const proposalOutput = outputFn ? outputFn(input.index, 0) : `proposal-${input.index}`;
    input.proposalBarriers[input.index].resolve(proposalOutput);
    let lastOutput = proposalOutput;
    for (let r = 0; r < input.rounds; r++) {
      const rebutOutput = outputFn ? outputFn(input.index, r + 1) : `rebuttal-${r + 1}-${input.index}`;
      input.rebutBarriers[r][input.index].resolve(rebutOutput);
      lastOutput = rebutOutput;
    }
    return { success: true, rebut: lastOutput };
  };
}

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => makeLogger());
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

describe("DebateRunner hybrid rebuttal", () => {
  withDepsRestore(_hybridDeps);

  test("with 2 debaters and rounds=1, the coordinator assigns distinct session roles per debater", async () => {
    const runner = makeRunner();
    const sessionRoles: string[] = [];

    installCallOp(async (callCtx, _op, input) => {
      sessionRoles.push((callCtx as CallContext).sessionOverride?.role ?? "");
      input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
      input.rebutBarriers[0][input.index].resolve(`rebuttal-${input.index}`);
      return { success: true, rebut: `rebuttal-${input.index}` };
    });

    await runner.run("test prompt");

    expect(sessionRoles).toEqual(["debate-hybrid-0", "debate-hybrid-1"]);
  });

  test("with 3 debaters and rounds=2, coordinator sets up 3 debaters × 2 rounds of rebuttal barriers", async () => {
    const runner = makeRunner({
      rounds: 2,
      debaters: [
        { agent: "claude", model: "fast" },
        { agent: "opencode", model: "fast" },
        { agent: "gemini", model: "fast" },
      ],
    });
    const barrierShapes: Array<{ slots: number; rounds: number }> = [];

    installCallOp(async (_callCtx, _op, input) => {
      barrierShapes.push({ slots: input.proposalBarriers.length, rounds: input.rebutBarriers.length });
      input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
      for (let r = 0; r < input.rounds; r++) {
        input.rebutBarriers[r][input.index].resolve(`rebut-${r + 1}-${input.index}`);
      }
      return { success: true, rebut: `rebut-2-${input.index}` };
    });

    await runner.run("test prompt");

    expect(barrierShapes).toHaveLength(3);
    for (const shape of barrierShapes) {
      expect(shape.slots).toBe(3); // one barrier slot per debater
      expect(shape.rounds).toBe(2); // two rebuttal rounds
    }
  });

  test("each debater's buildRebutPrompt callback includes all successful proposal outputs", async () => {
    const runner = makeRunner();
    const capturedBuildRebutPrompts: Array<DebateHybridInput["buildRebutPrompt"]> = [];

    installCallOp(async (_callCtx, _op, input) => {
      capturedBuildRebutPrompts.push(input.buildRebutPrompt);
      input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
      input.rebutBarriers[0][input.index].resolve(`rebuttal-${input.index}`);
      return { success: true, rebut: `rebuttal-${input.index}` };
    });

    await runner.run("test prompt");

    expect(capturedBuildRebutPrompts).toHaveLength(2);
    for (const buildRebutPrompt of capturedBuildRebutPrompts) {
      const prompt = buildRebutPrompt(1, ["proposal-0", "proposal-1"], []);
      expect(prompt).toContain("proposal-0");
      expect(prompt).toContain("proposal-1");
    }
  });

  test("buildRebutPrompt for round 2 receives prior round outputs via priorRoundOutputs", async () => {
    const runner = makeRunner({ rounds: 2 });
    const capturedBuildRebutPrompts: Array<DebateHybridInput["buildRebutPrompt"]> = [];

    installCallOp(async (_callCtx, _op, input) => {
      capturedBuildRebutPrompts.push(input.buildRebutPrompt);
      input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
      for (let r = 0; r < input.rounds; r++) {
        input.rebutBarriers[r][input.index].resolve(`rebut-${r + 1}-${input.index}`);
      }
      return { success: true, rebut: `rebut-2-${input.index}` };
    });

    await runner.run("test prompt");

    expect(capturedBuildRebutPrompts).toHaveLength(2);
    // Simulate hopBody calling buildRebutPrompt for round 2 with round-1 outputs as prior data
    const round2Prompt = capturedBuildRebutPrompts[0](2, ["proposal-0", "proposal-1"], [["rebut-1-0", "rebut-1-1"]]);
    expect(round2Prompt).toContain("rebut-1-0");
    expect(round2Prompt).toContain("rebut-1-1");
  });

  test("when one callOp fails, the runner still returns a result with the remaining debater", async () => {
    const runner = makeRunner();

    installCallOp(async (_callCtx, _op, input) => {
      if (input.index === 0) {
        input.proposalBarriers[input.index].resolve("proposal-0");
        input.rebutBarriers[0][input.index].resolve("rebuttal-0");
        return { success: true, rebut: "rebuttal-0" };
      }
      throw new Error("debater failed");
    });

    const result = await runner.run("test prompt");

    expect(result.storyId).toBe("US-test");
    // With < 2 successful debaters, falls back to single-debater result
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toHaveLength(1);
  });

  test("proposal and rebuttal turns for the same debater share the same session role", async () => {
    const runner = makeRunner({ rounds: 2 });
    const rolesByIndex = new Map<number, string>();

    installCallOp(async (callCtx, _op, input) => {
      rolesByIndex.set(input.index, (callCtx as CallContext).sessionOverride?.role ?? "");
      input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
      for (let r = 0; r < input.rounds; r++) {
        input.rebutBarriers[r][input.index].resolve(`rebut-${r + 1}-${input.index}`);
      }
      return { success: true, rebut: `rebut-2-${input.index}` };
    });

    await runner.run("test prompt");

    // Each debater is dispatched via a single callOp — same role covers proposal + all rebuttals
    expect(rolesByIndex.get(0)).toBe("debate-hybrid-0");
    expect(rolesByIndex.get(1)).toBe("debate-hybrid-1");
  });

  test("callContext forwarded to callOp does not have onCostAccumulated (AC12)", async () => {
    const runner = makeRunner();
    let capturedCallCtx: CallContext | undefined;

    installCallOp(async (callCtx, _op, input) => {
      capturedCallCtx = callCtx as CallContext;
      input.proposalBarriers[input.index].resolve(`proposal-${input.index}`);
      input.rebutBarriers[0][input.index].resolve(`rebuttal-${input.index}`);
      return { success: true, rebut: `rebuttal-${input.index}` };
    });

    await runner.run("test prompt");

    expect(capturedCallCtx).toBeDefined();
    expect("onCostAccumulated" in (capturedCallCtx ?? {})).toBe(false);
  });

  test("DebateResult.rebuttals contains one entry per debater per round, collected from shared barriers", async () => {
    const runner = makeRunner();

    installCallOp(makeHybridOpMock());

    const result = await runner.run("test prompt");

    expect(result.rebuttals).toEqual([
      { debater: { agent: "claude", model: "fast" }, round: 1, output: "rebuttal-1-0" },
      { debater: { agent: "opencode", model: "fast" }, round: 1, output: "rebuttal-1-1" },
    ]);
  });
});
