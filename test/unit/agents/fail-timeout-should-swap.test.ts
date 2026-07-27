import { describe, expect, test } from "bun:test";
import { AgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import type { AdapterFailure } from "@/context/engine";

// Shared run options used by runWithFallback tests.
const RUN_OPTIONS = {
  prompt: "test",
  workdir: "/tmp",
  modelTier: "fast" as const,
  modelDef: { provider: "anthropic" as const, model: "claude-haiku-4-5" as const },
  timeoutSeconds: 30,
  config: DEFAULT_CONFIG,
  storyId: "us-001",
};

const failTimeoutRetryable: AdapterFailure = {
  category: "quality",
  outcome: "fail-timeout",
  retriable: true,
  message: "wall-clock timeout exceeded",
};

// AC10: shouldSwap returns false for fail-timeout quality failure when
// agent.fallback.onQualityFailure is unset (default).
describe("AgentManager.shouldSwap with fail-timeout (US-001 AC10)", () => {
  test("returns false when onQualityFailure is unset (default)", () => {
    const manager = new AgentManager({
      ...DEFAULT_CONFIG,
      agent: {
        ...DEFAULT_CONFIG.agent,
        fallback: {
          enabled: true,
          map: { claude: ["codex"] },
          maxHopsPerStory: 2,
          onQualityFailure: false,
          rebuildContext: true,
        },
      },
    } as never);
    expect(manager.shouldSwap(failTimeoutRetryable, 0, true)).toBe(false);
  });

  test("returns false when fallback config is absent", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(manager.shouldSwap(failTimeoutRetryable, 0, true)).toBe(false);
  });

  test("returns true only when onQualityFailure is explicitly enabled", () => {
    // Documents the opt-in: a project that explicitly opts into quality-failure
    // swaps can still treat wall-clock timeouts as swap-worthy. The default
    // story acceptance criterion targets the unset case (false).
    const manager = new AgentManager({
      ...DEFAULT_CONFIG,
      agent: {
        ...DEFAULT_CONFIG.agent,
        fallback: {
          enabled: true,
          map: { claude: ["codex"] },
          maxHopsPerStory: 2,
          onQualityFailure: true,
          rebuildContext: true,
        },
      },
    } as never);
    expect(manager.shouldSwap(failTimeoutRetryable, 0, true)).toBe(true);
  });
});

// AC11: when runWithFallback receives a hop result with adapterFailure.outcome
// "fail-timeout", the dispatched agent is NOT marked unavailable for subsequent
// calls — a single slow story must not poison the agent pool.
describe("AgentManager.runWithFallback with fail-timeout (US-001 AC11)", () => {
  test("does NOT mark the dispatched agent unavailable for fail-timeout outcome", async () => {
    let dispatchedAgents: string[] = [];

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          fallback: {
            // Swap is disabled — fail-timeout must terminate the hop but
            // never poison the agent pool (AC11).
            enabled: false,
            map: {},
            maxHopsPerStory: 0,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
      undefined,
      {
        runHop: async (agent) => {
          dispatchedAgents.push(agent);
          return {
            result: {
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
              adapterFailure: failTimeoutRetryable,
            },
            prompt: "test prompt",
          };
        },
      },
    );

    await manager.runWithFallback({ runOptions: RUN_OPTIONS });

    expect(dispatchedAgents).toEqual(["claude"]);
    expect(manager.isUnavailable("claude")).toBe(false);
  });

  test("does NOT mark the dispatched agent unavailable even when swap is enabled (onQualityFailure default)", async () => {
    let dispatchedAgents: string[] = [];

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          fallback: {
            // Swap IS enabled but onQualityFailure defaults to false — the
            // fail-timeout quality failure must not trigger markUnavailable
            // because shouldSwap returns false (AC10), and the swap branch
            // is the only path that calls markUnavailable.
            enabled: true,
            map: { claude: ["codex"] },
            maxHopsPerStory: 2,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
      undefined,
      {
        runHop: async (agent) => {
          dispatchedAgents.push(agent);
          return {
            result: {
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
              adapterFailure: failTimeoutRetryable,
            },
            prompt: "test prompt",
          };
        },
      },
    );

    const outcome = await manager.runWithFallback({ runOptions: RUN_OPTIONS });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-timeout");
    // Single hop — no swap, no same-agent retry (fail-timeout is not fail-stale).
    expect(dispatchedAgents).toEqual(["claude"]);
    // The dispatched agent must NOT be marked unavailable (AC11).
    expect(manager.isUnavailable("claude")).toBe(false);
  });

  test("subsequent stories can still dispatch to the same agent after a fail-timeout", async () => {
    // AC11 hardening: even after the manager has processed a fail-timeout
    // result, the next runWithFallback call should still dispatch to the
    // primary agent (not be silently rerouted because of pool poisoning).
    let firstStoryAgents: string[] = [];
    let secondStoryAgents: string[] = [];
    let storyCount = 0;

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          fallback: {
            enabled: true,
            map: { claude: ["codex"] },
            maxHopsPerStory: 2,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
      undefined,
      {
        runHop: async (agent) => {
          const target = storyCount === 0 ? firstStoryAgents : secondStoryAgents;
          target.push(agent);
          if (storyCount === 0) {
            return {
              result: {
                success: false,
                exitCode: 1,
                output: "",
                rateLimited: false,
                durationMs: 100,
                estimatedCostUsd: 0,
                adapterFailure: failTimeoutRetryable,
              },
              prompt: "first story",
            };
          }
          return {
            result: {
              success: true,
              exitCode: 0,
              output: "ok",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
            },
            prompt: "second story",
          };
        },
      },
    );

    // First story: fail-timeout
    storyCount = 0;
    await manager.runWithFallback({ runOptions: RUN_OPTIONS });
    // Second story: a fresh run (simulating the next story in the same run)
    storyCount = 1;
    const secondOutcome = await manager.runWithFallback({ runOptions: RUN_OPTIONS });

    expect(firstStoryAgents).toEqual(["claude"]);
    expect(secondStoryAgents).toEqual(["claude"]); // Same agent — pool not poisoned
    expect(secondOutcome.result.success).toBe(true);
  });
});