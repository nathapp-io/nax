/**
 * AutoInteractionPlugin — IAgentManager.complete() integration tests (AA-004)
 *
 * Tests that auto.ts uses agentManager.complete() via _deps.agentManager instead of
 * spawning the claude CLI directly. All acceptance criteria from AA-004.
 *
 * These tests are RED until auto.ts is refactored.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _autoPluginDeps as _deps, AutoInteractionPlugin } from "../../../src/interaction/plugins/auto";
import type { IAgentManager } from "../../../src/agents/manager-types";
import type { InteractionRequest } from "../../../src/interaction/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(id: string, overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id,
    type: "confirm",
    featureName: "test-feature",
    stage: "review",
    summary: "Should we proceed?",
    fallback: "continue",
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Build a minimal mock IAgentManager where complete() is a spy.
 * complete() returns CompleteResult { output: string, costUsd: number, source: string }
 */
function makeAgentManager(
  completeImpl?: (prompt: string, options?: any) => Promise<{ output: string; costUsd: number; source: string }>,
): { mgr: IAgentManager; completeMock: ReturnType<typeof mock> } {
  const completeMock = mock(
    completeImpl ??
      (async () => ({ output: JSON.stringify({ action: "approve", confidence: 0.9, reasoning: "ok" }), costUsd: 0, source: "mock" as const })),
  );
  return {
    mgr: {
      getDefault: () => "claude",
      complete: completeMock,
      completeAs: completeMock,
      completeWithFallback: async (prompt: string, opts?: any) => ({ result: await completeMock(prompt, opts), fallbacks: [] }),
      run: mock(async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] })),
      runAs: mock(async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] })),
      isUnavailable: () => false,
      markUnavailable: () => {},
      reset: () => {},
      validateCredentials: async () => {},
      resolveFallbackChain: () => [],
      shouldSwap: () => false,
      nextCandidate: () => null,
      plan: async () => ({ specContent: "" }),
      decompose: async () => ({ stories: [] }),
      getAgent: () => ({ run: mock(async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0 })) } as any),
      events: { on: () => {} },
    } as unknown as IAgentManager,
    completeMock,
  };
}

/** Valid JSON response a real agentManager.complete() output would contain */
function approveJson(confidence = 0.9): string {
  return JSON.stringify({ action: "approve", confidence, reasoning: "safe to proceed" });
}

function rejectJson(confidence = 0.85): string {
  return JSON.stringify({ action: "reject", confidence, reasoning: "risky operation" });
}

function chooseJson(value: string, confidence = 0.92): string {
  return JSON.stringify({ action: "choose", value, confidence, reasoning: "best option" });
}

// ---------------------------------------------------------------------------
// Save/restore _deps.agentManager across tests
// ---------------------------------------------------------------------------

const originalAgentManager = (_deps as Record<string, unknown>).agentManager ?? null;

afterEach(() => {
  mock.restore();
  (_deps as Record<string, unknown>).agentManager = originalAgentManager;
});

// ---------------------------------------------------------------------------
// AC-1: auto.ts no longer spawns 'claude' directly
// ---------------------------------------------------------------------------

describe("auto.ts does not spawn claude CLI directly", () => {
  test("decide() does not call Bun.spawn when agentManager is injected", async () => {
    const spawnSpy = mock(() => {
      throw new Error("Bun.spawn must not be called — use agentManager.complete() instead");
    });

    const plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.7 });

    const { mgr } = makeAgentManager(async () => ({ output: approveJson(), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const originalSpawn = Bun.spawn;
    (Bun as Record<string, unknown>).spawn = spawnSpy;

    try {
      const response = await plugin.decide(makeRequest("req-no-spawn"));
      expect(response?.action).toBe("approve");
      expect(spawnSpy.mock.calls).toHaveLength(0);
    } finally {
      (Bun as Record<string, unknown>).spawn = originalSpawn;
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2: Uses agentManager.complete() for generating auto-responses
// ---------------------------------------------------------------------------

describe("agentManager.complete() is called with correct arguments", () => {
  let plugin: AutoInteractionPlugin;

  beforeEach(async () => {
    plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.7 });
  });

  test("agentManager.complete() is called exactly once per decide() invocation", async () => {
    const { mgr, completeMock } = makeAgentManager(async () => ({ output: approveJson(), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    await plugin.decide(makeRequest("req-once"));

    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  test("agentManager.complete() receives a non-empty prompt string", async () => {
    const { mgr, completeMock } = makeAgentManager(async () => ({ output: approveJson(), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    await plugin.decide(makeRequest("req-prompt", { summary: "Is this safe?" }));

    const [prompt] = completeMock.mock.calls[0] as [string, any];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("agentManager.complete() prompt contains the request summary", async () => {
    const { mgr, completeMock } = makeAgentManager(async () => ({ output: approveJson(), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const summary = "Should we merge this story?";
    await plugin.decide(makeRequest("req-summary", { summary }));

    const [prompt] = completeMock.mock.calls[0] as [string, any];
    expect(prompt).toContain(summary);
  });

  test("agentManager.complete() receives jsonMode: true option", async () => {
    const { mgr, completeMock } = makeAgentManager(async () => ({ output: approveJson(), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    await plugin.decide(makeRequest("req-json-mode"));

    const [, options] = completeMock.mock.calls[0] as [string, any];
    expect(options?.jsonMode).toBe(true);
  });

  test("agentManager.complete() receives model option when naxConfig provides one", async () => {
    const pluginWithModel = new AutoInteractionPlugin();
    await pluginWithModel.init({
      model: "fast",
      naxConfig: {
        models: {
          claude: {
            fast: { model: "claude-haiku-4-5", provider: "anthropic" },
          },
        },
        agent: { default: "claude" },
      } as any,
    });

    const { mgr, completeMock } = makeAgentManager(async () => ({ output: approveJson(), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    await pluginWithModel.decide(makeRequest("req-model"));

    const [, options] = completeMock.mock.calls[0] as [string, any];
    expect(options?.model).toBe("claude-haiku-4-5");
  });
});

// ---------------------------------------------------------------------------
// AC-3: AgentManager resolved via dependency injection
// ---------------------------------------------------------------------------

describe("agentManager dependency injection via _deps.agentManager", () => {
  test("_deps.agentManager property exists on the exported _deps object", () => {
    expect("agentManager" in _deps).toBe(true);
  });

  test("_deps.agentManager defaults to null (not set at module load)", () => {
    expect((_deps as Record<string, unknown>).agentManager).toBeNull();
  });

  test("setting _deps.agentManager causes agentManager.complete() to be invoked instead of CLI", async () => {
    const plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.5 });

    let completeCalled = false;
    const { mgr } = makeAgentManager(async () => {
      completeCalled = true;
      return { output: approveJson(0.9), costUsd: 0, source: "mock" };
    });
    (_deps as Record<string, unknown>).agentManager = mgr;

    await plugin.decide(makeRequest("req-di-check"));

    expect(completeCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-4: Auto-response behaviour unchanged
// ---------------------------------------------------------------------------

describe("auto-response behaviour is preserved after adapter migration", () => {
  let plugin: AutoInteractionPlugin;

  beforeEach(async () => {
    plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.7 });
  });

  test("agentManager returns approve JSON → response.action is approve", async () => {
    const { mgr } = makeAgentManager(async () => ({ output: approveJson(0.9), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(makeRequest("req-approve"));

    expect(response).not.toBeUndefined();
    expect(response?.action).toBe("approve");
    expect(response?.respondedBy).toBe("auto-ai");
    expect(response?.requestId).toBe("req-approve");
  });

  test("agentManager returns reject JSON → response.action is reject", async () => {
    const { mgr } = makeAgentManager(async () => ({ output: rejectJson(0.85), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(makeRequest("req-reject"));

    expect(response?.action).toBe("reject");
  });

  test("agentManager returns choose JSON with value → value is propagated", async () => {
    const { mgr } = makeAgentManager(async () => ({ output: chooseJson("option-b"), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(
      makeRequest("req-choose", {
        type: "choose",
        options: [
          { key: "a", label: "Option A" },
          { key: "b", label: "Option B" },
        ],
      }),
    );

    expect(response?.action).toBe("choose");
    expect(response?.value).toBe("option-b");
  });

  test("confidence below threshold → returns undefined (escalates)", async () => {
    const { mgr } = makeAgentManager(async () => ({ output: approveJson(0.5), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(makeRequest("req-low-conf"));

    expect(response).toBeUndefined();
  });

  test("confidence exactly at threshold → response returned", async () => {
    const pluginAtThreshold = new AutoInteractionPlugin();
    await pluginAtThreshold.init({ confidenceThreshold: 0.8 });

    const { mgr } = makeAgentManager(async () => ({ output: approveJson(0.8), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await pluginAtThreshold.decide(makeRequest("req-at-threshold"));

    expect(response).not.toBeUndefined();
    expect(response?.action).toBe("approve");
  });

  test("security-review trigger → returns undefined without calling agentManager", async () => {
    let completeCalled = false;
    const { mgr } = makeAgentManager(async () => {
      completeCalled = true;
      return { output: approveJson(), costUsd: 0, source: "mock" };
    });
    (_deps as Record<string, unknown>).agentManager = mgr;

    const request = makeRequest("req-sec", {
      metadata: { trigger: "security-review", safety: "red" },
    });

    const response = await plugin.decide(request);

    expect(response).toBeUndefined();
    expect(completeCalled).toBe(false);
  });

  test("agentManager.complete() throws → returns undefined (escalates to human)", async () => {
    const { mgr } = makeAgentManager(async () => {
      throw new Error("LLM unavailable");
    });
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(makeRequest("req-error"));

    expect(response).toBeUndefined();
  });

  test("agentManager.complete() returns malformed JSON → returns undefined (escalates)", async () => {
    const { mgr } = makeAgentManager(async () => ({ output: "not valid json {{{", costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(makeRequest("req-bad-json"));

    expect(response).toBeUndefined();
  });

  test("agentManager.complete() returns JSON with missing fields → returns undefined", async () => {
    const { mgr } = makeAgentManager(async () =>
      ({ output: JSON.stringify({ action: "approve" }), costUsd: 0, source: "mock" }), // missing confidence and reasoning
    );
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(makeRequest("req-incomplete"));

    expect(response).toBeUndefined();
  });

  test("respondedAt is set to a recent timestamp", async () => {
    const before = Date.now();
    const { mgr } = makeAgentManager(async () => ({ output: approveJson(), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(makeRequest("req-timestamp"));

    const after = Date.now();
    expect(response?.respondedAt).toBeGreaterThanOrEqual(before);
    expect(response?.respondedAt).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// AC-5: Unit tests mock agentManager.complete() (verified by test structure above)
// — Additional edge case: markdown-wrapped JSON is stripped before parsing
// ---------------------------------------------------------------------------

describe("agentManager.complete() response parsing handles markdown-wrapped JSON", () => {
  let plugin: AutoInteractionPlugin;

  beforeEach(async () => {
    plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.7 });
  });

  test("markdown-wrapped JSON is unwrapped and parsed correctly", async () => {
    const wrappedJson = "```json\n" + approveJson(0.95) + "\n```";
    const { mgr } = makeAgentManager(async () => ({ output: wrappedJson, costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(makeRequest("req-markdown"));

    expect(response?.action).toBe("approve");
  });

  test("plain JSON without markdown fences is parsed correctly", async () => {
    const { mgr } = makeAgentManager(async () => ({ output: approveJson(0.88), costUsd: 0, source: "mock" }));
    (_deps as Record<string, unknown>).agentManager = mgr;

    const response = await plugin.decide(makeRequest("req-plain-json"));

    expect(response?.action).toBe("approve");
  });
});
