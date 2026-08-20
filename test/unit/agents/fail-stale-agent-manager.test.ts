import { describe, expect, test } from "bun:test";
import { AgentManager } from "@/agents/manager";
import { DEFAULT_CONFIG } from "@/config/defaults";
import type { AdapterFailure } from "@/context/engine";

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

// Shared run options used by all runWithFallback tests
const RUN_OPTIONS = {
  prompt: "test",
  workdir: "/tmp",
  modelTier: "fast" as const,
  modelDef: { provider: "anthropic" as const, model: "claude-haiku-4-5" as const },
  timeoutSeconds: 30,
  config: DEFAULT_CONFIG,
  storyId: "us-001",
};

// Helper: flat AgentResult wrapped in SessionRunHopResult so TypeScript is satisfied.
// AgentManager normalises both flat and wrapped forms at runtime; the wrapper is
// the canonical shape declared by SessionRunHopFn.
function hopResult(result: Parameters<typeof AgentManager.prototype.runWithFallback>[0]["runOptions"] extends never ? never : {
  success: boolean;
  exitCode: number;
  output: string;
  rateLimited: boolean;
  durationMs: number;
  estimatedCostUsd: number;
  adapterFailure?: AdapterFailure;
}) {
  return { result, prompt: "test prompt" };
}

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
        runHop: async () => {
          callCount++;
          if (callCount === 1) {
            return hopResult({
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
              adapterFailure: staleFailureRetryable,
            });
          }
          return hopResult({ success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 100, estimatedCostUsd: 0 });
        },
      },
    );

    const outcome = await manager.runWithFallback({ runOptions: RUN_OPTIONS });

    expect(outcome.result.success).toBe(true);
    expect(outcome.fallbacks.length).toBeGreaterThan(0);
  });

  test("retries with same agent before fallback when fail-stale.retriable=true", async () => {
    const agents: string[] = [];

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
            return hopResult({
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
              adapterFailure: staleFailureRetryable,
            });
          }
          return hopResult({ success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 100, estimatedCostUsd: 0 });
        },
      },
    );

    const outcome = await manager.runWithFallback({ runOptions: RUN_OPTIONS });

    expect(outcome.result.success).toBe(true);
    expect(agents[0]).toBe("claude");
    expect(agents[1]).toBe("claude"); // Same agent should be retried before fallback
  });

  test("falls back to alternate agent when fail-stale retries exhausted", async () => {
    const agents: string[] = [];

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          idleWatchdog: {
            enabled: true,
            mode: "warn-then-cancel",
            idleTimeoutSeconds: 900,
            activityKinds: ["message_update", "thinking_update", "usage_update"],
            cancelGraceSeconds: 10,
            maxRetryAttempts: 1,
          },
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
            return hopResult({
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
              adapterFailure: staleFailureRetryable,
            });
          }
          return hopResult({ success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 100, estimatedCostUsd: 0 });
        },
      },
    );

    const outcome = await manager.runWithFallback({ runOptions: RUN_OPTIONS });

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
        runHop: async () =>
          hopResult({
            success: false,
            exitCode: 1,
            output: "",
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0,
            adapterFailure: staleFailureRetryable,
          }),
      },
    );

    const outcome = await manager.runWithFallback({ runOptions: RUN_OPTIONS });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-stale");
  });

  // AC4: Retry for fail-stale stops after maxRetryAttempts attempts.
  // The manager reads maxRetryAttempts from config.agent.idleWatchdog.maxRetryAttempts.

  test("fail-stale same-agent retries respect maxRetryAttempts=3 from idleWatchdog config (AC4)", async () => {
    const MAX_RETRY_ATTEMPTS = 3;
    const agents: string[] = [];

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          acp: { promptRetries: 0 },
          idleWatchdog: {
            enabled: true,
            mode: "cancel",
            idleTimeoutSeconds: 30,
            activityKinds: ["message_update", "thinking_update", "usage_update"],
            cancelGraceSeconds: 5,
            maxRetryAttempts: MAX_RETRY_ATTEMPTS,
          },
          fallback: {
            enabled: false, // No fallback — isolate retry behavior
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
          agents.push(agent);
          return hopResult({
            success: false,
            exitCode: 1,
            output: "",
            rateLimited: false,
            durationMs: 100,
            estimatedCostUsd: 0,
            adapterFailure: staleFailureRetryable,
          });
        },
      },
    );

    const outcome = await manager.runWithFallback({ runOptions: RUN_OPTIONS });

    // Manager must retry with the same agent exactly maxRetryAttempts times:
    // 1 initial attempt + MAX_RETRY_ATTEMPTS retries = MAX_RETRY_ATTEMPTS + 1 total calls
    expect(agents).toHaveLength(MAX_RETRY_ATTEMPTS + 1);
    expect(agents.every((a) => a === "claude")).toBe(true);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-stale");
  });

  test("fail-stale with maxRetryAttempts=0 does not retry before fallback (AC4)", async () => {
    const agents: string[] = [];

    const manager = new AgentManager(
      {
        ...DEFAULT_CONFIG,
        agent: {
          ...DEFAULT_CONFIG.agent,
          acp: { promptRetries: 0 },
          idleWatchdog: {
            enabled: true,
            mode: "cancel",
            idleTimeoutSeconds: 30,
            activityKinds: ["message_update", "thinking_update", "usage_update"],
            cancelGraceSeconds: 5,
            maxRetryAttempts: 0, // No same-agent retries allowed
          },
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
          agents.push(agent);
          if (agent === "claude") {
            return hopResult({
              success: false,
              exitCode: 1,
              output: "",
              rateLimited: false,
              durationMs: 100,
              estimatedCostUsd: 0,
              adapterFailure: staleFailureRetryable,
            });
          }
          return hopResult({ success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 100, estimatedCostUsd: 0 });
        },
      },
    );

    const outcome = await manager.runWithFallback({ runOptions: RUN_OPTIONS });

    // With maxRetryAttempts=0: first stale → immediate fallback, no same-agent retry
    expect(agents[0]).toBe("claude"); // Initial attempt
    expect(agents[1]).toBe("codex"); // Immediate fallback — no claude retry
    expect(agents).toHaveLength(2);
    expect(outcome.result.success).toBe(true);
  });
});
