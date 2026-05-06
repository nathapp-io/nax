import { describe, expect, test, beforeEach } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { AdapterFailure } from "../../../src/context/engine";
import type { IAgentManager } from "../../../src/agents/manager-types";
import { makeMockAgentManager } from "../../helpers";

const staleFailureRetryable: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  message: "idle watchdog: no stream activity",
};

const staleFailureTerminal: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: false,
  message: "stale retries exhausted",
};

describe("AgentManager with fail-stale availability failures", () => {
  test("shouldSwap() returns true for fail-stale availability failure when hasBundle=true", () => {
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
    expect(manager.shouldSwap(staleFailureRetryable, 0, true)).toBe(true);
  });

  test("shouldSwap() returns false for fail-stale when hasBundle=false", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    expect(manager.shouldSwap(staleFailureRetryable, 0, false)).toBe(false);
  });

  test("fail-stale does NOT trigger quality escalation (category is availability)", () => {
    const manager = new AgentManager({
      ...DEFAULT_CONFIG,
      agent: {
        ...DEFAULT_CONFIG.agent,
        fallback: {
          enabled: true,
          map: { claude: ["codex"] },
          maxHopsPerStory: 2,
          onQualityFailure: true, // escalate on quality failures
          rebuildContext: true,
        },
      },
    } as never);
    // shouldSwap checks category != 'quality' for onQualityFailure
    // fail-stale is availability, so should not trigger quality escalation
    expect(manager.shouldSwap(staleFailureRetryable, 0, true)).toBe(true);
  });

  test("markUnavailable() with fail-stale marks agent as unavailable", () => {
    const manager = new AgentManager(DEFAULT_CONFIG);
    manager.markUnavailable("claude", staleFailureTerminal);
    expect(manager.isUnavailable("claude")).toBe(true);
  });

  test("nextCandidate() returns fallback agent when primary fails with fail-stale", () => {
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
    const next = manager.nextCandidate("claude", 0);
    expect(next).toBe("codex");
  });
});

describe("AgentManager.runWithFallback with fail-stale", () => {
  test("recognizes fail-stale as availability failure and includes in fallbacks array", async () => {
    let callCount = 0;
    let passedAgent = "";

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          fallback: {
            enabled: true,
            map: { claude: ["codex"] },
            maxHopsPerStory: 3,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
      undefined,
      {
        runHop: async (agent) => {
          passedAgent = agent;
          callCount++;
          if (callCount === 1) {
            return {
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
              adapterFailure: staleFailureRetryable,
            };
          }
          return { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 100, estimatedCostUsd: 0 };
        },
      },
    );

    const outcome = await manager.runWithFallback({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
        timeoutSeconds: 30,
        config: DEFAULT_CONFIG,
        storyId: "us-001",
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks.length).toBeGreaterThan(0);
  });

  test("retries with same agent before fallback when fail-stale.retriable=true", async () => {
    let callCount = 0;
    let agents: string[] = [];

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          fallback: {
            enabled: true,
            map: { claude: ["codex"] },
            maxHopsPerStory: 5,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
      undefined,
      {
        runHop: async (agent) => {
          agents.push(agent);
          if (agents.length <= 2) {
            return {
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
              adapterFailure: staleFailureRetryable,
            };
          }
          return { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 100, estimatedCostUsd: 0 };
        },
      },
    );

    const outcome = await manager.runWithFallback({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
        timeoutSeconds: 30,
        config: DEFAULT_CONFIG,
        storyId: "us-001",
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(agents[0]).toBe("claude");
    expect(agents[1]).toBe("claude"); // Same agent should be retried before fallback
  });

  test("falls back to alternate agent when fail-stale retries exhausted", async () => {
    let callCount = 0;
    let agents: string[] = [];

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          fallback: {
            enabled: true,
            map: { claude: ["codex", "opencode"] },
            maxHopsPerStory: 5,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
      undefined,
      {
        runHop: async (agent) => {
          agents.push(agent);
          if (agents.length === 1 || agents.length === 2) {
            return {
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
              adapterFailure: staleFailureRetryable,
            };
          }
          return { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 100, estimatedCostUsd: 0 };
        },
      },
    );

    const outcome = await manager.runWithFallback({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
        timeoutSeconds: 30,
        config: DEFAULT_CONFIG,
        storyId: "us-001",
      },
    });

    expect(outcome.result.success).toBe(true);
    expect(agents[0]).toBe("claude");
    expect(agents[1]).toBe("claude");
    expect(agents[2]).toBe("codex"); // Fallback after exhausting retries
  });

  test("returns terminal failure when fail-stale exhausts retries and no fallback available", async () => {
    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          fallback: {
            enabled: false, // No fallback
            map: {},
            maxHopsPerStory: 1,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      } as never,
      undefined,
      {
        runHop: async () => {
          return {
            success: false,
            exitCode: 1,
            output: "",
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0,
            adapterFailure: staleFailureRetryable,
          };
        },
      },
    );

    const outcome = await manager.runWithFallback({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
        timeoutSeconds: 30,
        config: DEFAULT_CONFIG,
        storyId: "us-001",
      },
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-stale");
  });
});
