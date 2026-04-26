/**
 * IAgentManager.run() / complete() / getAgent() — Phase 1 (ADR-013).
 *
 * run() and complete() are thin delegates over runWithFallback /
 * completeWithFallback. They exist so SessionManager.runInSession and
 * other callers receive a uniform IAgentManager surface without holding
 * references to the internal fallback methods.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentManager, _agentManagerDeps } from "../../../src/agents/manager";
import type { AgentRunRequest } from "../../../src/agents/manager-types";
import type { AgentAdapter } from "../../../src/agents/types";
import { SessionFailureError } from "../../../src/agents/types";
import { makeNaxConfig } from "../../../test/helpers";

describe("IAgentManager.run()", () => {
  test("delegates to runWithFallback and returns AgentResult", async () => {
    const mgr = new AgentManager(
      makeNaxConfig({
        agent: { default: "claude", fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } },
      }),
      undefined,
      {
        runHop: async () => ({
          prompt: "test",
          result: {
            success: true,
            exitCode: 0,
            output: "ok",
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.001,
          },
        }),
      },
    );

    const request: AgentRunRequest = {
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "m", env: {} },
        timeoutSeconds: 30,
        config: makeNaxConfig({ agent: { default: "claude", fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } } }),
      },
    };

    const result = await mgr.run(request);

    expect(result.success).toBe(true);
    expect(result.output).toBe("ok");
  });

  test("copies fallback records into result.agentFallbacks on success", async () => {
    const mgr = new AgentManager(
      makeNaxConfig({
        agent: { default: "claude", fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } },
      }),
      undefined,
      {
        runHop: async () => ({
          prompt: "test",
          result: {
            success: true,
            exitCode: 0,
            output: "ok",
            rateLimited: false,
            durationMs: 1,
            estimatedCost: 0.001,
          },
        }),
      },
    );

    const result = await mgr.run({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "m", env: {} },
        timeoutSeconds: 30,
        config: makeNaxConfig({ agent: { default: "claude", fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } } }),
      },
    });

    // No fallback needed — empty array
    expect(result.agentFallbacks).toEqual([]);
  });
});

describe("IAgentManager.run() — agent swap", () => {
  let origSleep: typeof _agentManagerDeps.sleep;
  beforeEach(() => { origSleep = _agentManagerDeps.sleep; });
  afterEach(() => { _agentManagerDeps.sleep = origSleep; });

  test("result.agentFallbacks has hop records when agent swap occurred", async () => {
    const availFailure = { category: "availability" as const, outcome: "fail-auth" as const, retriable: false, message: "" };
    const mgr = new AgentManager(
      makeNaxConfig({
        agent: { default: "claude", fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } },
      }),
      undefined,
      {
        runHop: async (agentName) => ({
          prompt: "test",
          result:
            agentName === "claude"
              ? {
                  success: false,
                  exitCode: 1,
                  output: "auth failure",
                  rateLimited: false,
                  durationMs: 1,
                  estimatedCost: 0,
                  adapterFailure: availFailure,
                }
              : {
                  success: true,
                  exitCode: 0,
                  output: "ok",
                  rateLimited: false,
                  durationMs: 1,
                  estimatedCost: 0.001,
                },
        }),
      },
    );
    _agentManagerDeps.sleep = mock(async () => {});

    const result = await mgr.run({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "m", env: {} },
        timeoutSeconds: 30,
        config: makeNaxConfig({ agent: { default: "claude", fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } } }),
      },
      bundle: {} as never,
    });

    expect(result.success).toBe(true);
    expect(result.agentFallbacks).toHaveLength(1);
    expect(result.agentFallbacks?.[0]?.priorAgent).toBe("claude");
    expect(result.agentFallbacks?.[0]?.newAgent).toBe("codex");
  });
});

describe("IAgentManager.complete()", () => {
  test("delegates to completeWithFallback and returns CompleteResult", async () => {
    const adapter = {
      complete: mock(async () => ({ output: "complete-out", costUsd: 0.001, source: "exact" as const })),
    } as AgentAdapter;
    const mgr = new AgentManager(
      makeNaxConfig({
        agent: { default: "claude", fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } },
      }),
      { getAgent: () => adapter } as never,
    );

    const result = await mgr.complete("hello", {
      model: "claude-haiku",
      config: makeNaxConfig({ agent: { default: "claude", fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } } }),
      workdir: "/tmp",
    });

    expect(result.output).toBe("complete-out");
  });
});

describe("IAgentManager.getAgent()", () => {
  test("returns the adapter for a known agent name", () => {
    const adapter = {} as AgentAdapter;
    const mgr = new AgentManager(
      makeNaxConfig({
        agent: { default: "claude", fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } },
      }),
      { getAgent: () => adapter } as never,
    );

    expect(mgr.getAgent("claude")).toBe(adapter);
  });

  test("returns undefined for an unknown agent name", () => {
    const mgr = new AgentManager(
      makeNaxConfig({
        agent: { default: "claude", fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } },
      }),
      { getAgent: () => undefined } as never,
    );

    expect(mgr.getAgent("nonexistent")).toBeUndefined();
  });

  test("lazily creates registry and returns adapter when no explicit registry is provided (Phase 4)", () => {
    const mgr = new AgentManager(
      makeNaxConfig({
        agent: { default: "claude", fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true } },
      }),
    );
    expect(mgr.getAgent("claude")).not.toBeUndefined();
  });
});
