import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { debateConfigSelector } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager({
    completeFn: async (_name: string, _p: string, _o: unknown) => ({ output: '{"passed":true}', costUsd: 0, source: "primary" as const }),
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
    storyId: "US-001",
    featureName: "feat-a",
    ...overrides,
  };
}

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    mode: "panel",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "fast" },
    ],
    ...overrides,
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

describe("DebateRunner — one-shot panel mode", () => {
  test("run() returns passed result when both debaters succeed", async () => {
    const ctx = makeCallCtx();
    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });
    const result = await runner.run("test prompt");
    expect(result.outcome).toBe("passed");
    expect(result.stage).toBe("review");
    expect(result.storyId).toBe("US-001");
  });

  test("run() returns passed with single debater when second fails", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name: string, _p: string, _o: unknown) => {
        callCount++;
        if (callCount === 2) throw new Error("second debater failed");
        return { output: '{"passed":true}', costUsd: 0, source: "primary" as const };
      },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: makeSessionManager(),
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({ ctx, stage: "review", stageConfig: makeStageConfig(), config: DEFAULT_CONFIG, workdir: "/tmp" });
    const result = await runner.run("prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toHaveLength(1);
  });

  test("run() returns failed when all debaters fail", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => { throw new Error("all fail"); },
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: makeSessionManager(),
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({ ctx, stage: "review", stageConfig: makeStageConfig(), config: DEFAULT_CONFIG, workdir: "/tmp" });
    const result = await runner.run("prompt");
    expect(result.outcome).toBe("failed");
  });

  test("run() calls agentManager.completeAs per debater", async () => {
    const calls: string[] = [];
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name: string, _p: string, _o: unknown) => {
        calls.push(name);
        return { output: '{"passed":true}', costUsd: 0, source: "primary" as const };
      },
    });
    const stageConfig = makeStageConfig({
      debaters: [
        { agent: "claude", model: "fast" },
        { agent: "opencode", model: "fast" },
      ],
    });
    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: makeSessionManager(),
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });
    const runner = new DebateRunner({ ctx, stage: "review", stageConfig, config: DEFAULT_CONFIG, workdir: "/tmp" });
    await runner.run("prompt");
    expect(calls).toContain("claude");
    expect(calls).toContain("opencode");
  });

  test("constructor accepts a DebateConfig slice (no NaxConfig cast)", () => {
    const slice = debateConfigSelector.select(DEFAULT_CONFIG);
    const ctx = makeCallCtx();
    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStageConfig(),
      config: slice,
      workdir: "/tmp",
    });
    expect(runner).toBeDefined();
  });
});
