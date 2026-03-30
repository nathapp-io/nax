/**
 * AutoInteractionPlugin — adapter.complete() integration tests (AA-004)
 *
 * Tests that auto.ts uses adapter.complete() via _deps.adapter instead of
 * spawning the claude CLI directly. All acceptance criteria from AA-004.
 *
 * These tests are RED until auto.ts is refactored.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _autoPluginDeps as _deps, AutoInteractionPlugin } from "../../../src/interaction/plugins/auto";
import type { AgentAdapter, CompleteOptions } from "../../../src/agents/types";
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

/** Build a minimal mock AgentAdapter where complete() is a spy */
function makeAdapter(completeImpl?: (prompt: string, options?: CompleteOptions) => Promise<string>): AgentAdapter {
  return {
    name: "claude",
    displayName: "Claude",
    binary: "claude",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"],
      maxContextTokens: 200000,
      features: new Set(["tdd", "review", "refactor", "batch"]),
    },
    isInstalled: mock(async () => true),
    run: mock(async () => {
      throw new Error("run() not used in adapter tests");
    }),
    buildCommand: mock(() => []),
    plan: mock(async () => {
      throw new Error("plan() not used in adapter tests");
    }),
    decompose: mock(async () => {
      throw new Error("decompose() not used in adapter tests");
    }),
    complete: mock(completeImpl ?? (async () => JSON.stringify({ action: "approve", confidence: 0.9, reasoning: "ok" }))),
  } as unknown as AgentAdapter;
}

/** Valid JSON response a real adapter.complete() would return */
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
// Save/restore _deps.adapter across tests
// ---------------------------------------------------------------------------

// After refactoring, _deps should have an `adapter` field (not `callLlm`)
const originalAdapter = (_deps as Record<string, unknown>).adapter ?? null;

afterEach(() => {
  mock.restore();
  (_deps as Record<string, unknown>).adapter = originalAdapter;
});

// ---------------------------------------------------------------------------
// AC-1: auto.ts no longer spawns 'claude' directly
// ---------------------------------------------------------------------------

describe("auto.ts does not spawn claude CLI directly", () => {
  test("decide() does not call Bun.spawn when adapter is injected", async () => {
    const spawnSpy = mock(() => {
      throw new Error("Bun.spawn must not be called — use adapter.complete() instead");
    });

    const plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.7 });

    const adapter = makeAdapter(async () => approveJson());
    (_deps as Record<string, unknown>).adapter = adapter;

    // Temporarily replace Bun.spawn to verify it's not called
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
// AC-2: Uses adapter.complete() for generating auto-responses
// ---------------------------------------------------------------------------

describe("adapter.complete() is called with correct arguments", () => {
  let plugin: AutoInteractionPlugin;

  beforeEach(async () => {
    plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.7 });
  });

  test("adapter.complete() is called exactly once per decide() invocation", async () => {
    const adapter = makeAdapter(async () => approveJson());
    (_deps as Record<string, unknown>).adapter = adapter;

    await plugin.decide(makeRequest("req-once"));

    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  test("adapter.complete() receives a non-empty prompt string", async () => {
    const adapter = makeAdapter(async () => approveJson());
    (_deps as Record<string, unknown>).adapter = adapter;

    await plugin.decide(makeRequest("req-prompt", { summary: "Is this safe?" }));

    const [prompt] = (adapter.complete as ReturnType<typeof mock>).mock.calls[0] as [string, CompleteOptions?];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("adapter.complete() prompt contains the request summary", async () => {
    const adapter = makeAdapter(async () => approveJson());
    (_deps as Record<string, unknown>).adapter = adapter;

    const summary = "Should we merge this story?";
    await plugin.decide(makeRequest("req-summary", { summary }));

    const [prompt] = (adapter.complete as ReturnType<typeof mock>).mock.calls[0] as [string, CompleteOptions?];
    expect(prompt).toContain(summary);
  });

  test("adapter.complete() receives jsonMode: true option", async () => {
    const adapter = makeAdapter(async () => approveJson());
    (_deps as Record<string, unknown>).adapter = adapter;

    await plugin.decide(makeRequest("req-json-mode"));

    const [, options] = (adapter.complete as ReturnType<typeof mock>).mock.calls[0] as [string, CompleteOptions?];
    expect(options?.jsonMode).toBe(true);
  });

  test("adapter.complete() receives model option when naxConfig provides one", async () => {
    const pluginWithModel = new AutoInteractionPlugin();
    await pluginWithModel.init({
      model: "fast",
      naxConfig: {
        models: {
          claude: {
            fast: { model: "claude-haiku-4-5", provider: "anthropic" },
          },
        },
        autoMode: { defaultAgent: "claude" },
      },
    });

    const adapter = makeAdapter(async () => approveJson());
    (_deps as Record<string, unknown>).adapter = adapter;

    await pluginWithModel.decide(makeRequest("req-model"));

    const [, options] = (adapter.complete as ReturnType<typeof mock>).mock.calls[0] as [string, CompleteOptions?];
    expect(options?.model).toBe("claude-haiku-4-5");
  });
});

// ---------------------------------------------------------------------------
// AC-3: Adapter resolved via dependency injection
// ---------------------------------------------------------------------------

describe("adapter dependency injection via _deps.adapter", () => {
  test("_deps.adapter property exists on the exported _deps object", () => {
    expect("adapter" in _deps).toBe(true);
  });

  test("_deps.adapter defaults to null (not set at module load)", () => {
    expect((_deps as Record<string, unknown>).adapter).toBeNull();
  });

  test("setting _deps.adapter causes adapter.complete() to be invoked instead of CLI", async () => {
    const plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.5 });

    let completeCalled = false;
    const adapter = makeAdapter(async () => {
      completeCalled = true;
      return approveJson(0.9);
    });
    (_deps as Record<string, unknown>).adapter = adapter;

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

  test("adapter returns approve JSON → response.action is approve", async () => {
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => approveJson(0.9));

    const response = await plugin.decide(makeRequest("req-approve"));

    expect(response).not.toBeUndefined();
    expect(response?.action).toBe("approve");
    expect(response?.respondedBy).toBe("auto-ai");
    expect(response?.requestId).toBe("req-approve");
  });

  test("adapter returns reject JSON → response.action is reject", async () => {
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => rejectJson(0.85));

    const response = await plugin.decide(makeRequest("req-reject"));

    expect(response?.action).toBe("reject");
  });

  test("adapter returns choose JSON with value → value is propagated", async () => {
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => chooseJson("option-b"));

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
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => approveJson(0.5));

    const response = await plugin.decide(makeRequest("req-low-conf"));

    expect(response).toBeUndefined();
  });

  test("confidence exactly at threshold → response returned", async () => {
    const pluginAtThreshold = new AutoInteractionPlugin();
    await pluginAtThreshold.init({ confidenceThreshold: 0.8 });

    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => approveJson(0.8));

    const response = await pluginAtThreshold.decide(makeRequest("req-at-threshold"));

    expect(response).not.toBeUndefined();
    expect(response?.action).toBe("approve");
  });

  test("security-review trigger → returns undefined without calling adapter", async () => {
    let completeCalled = false;
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => {
      completeCalled = true;
      return approveJson();
    });

    const request = makeRequest("req-sec", {
      metadata: { trigger: "security-review", safety: "red" },
    });

    const response = await plugin.decide(request);

    expect(response).toBeUndefined();
    expect(completeCalled).toBe(false);
  });

  test("adapter.complete() throws → returns undefined (escalates to human)", async () => {
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => {
      throw new Error("LLM unavailable");
    });

    const response = await plugin.decide(makeRequest("req-error"));

    expect(response).toBeUndefined();
  });

  test("adapter.complete() returns malformed JSON → returns undefined (escalates)", async () => {
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => "not valid json {{{");

    const response = await plugin.decide(makeRequest("req-bad-json"));

    expect(response).toBeUndefined();
  });

  test("adapter.complete() returns JSON with missing fields → returns undefined", async () => {
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () =>
      JSON.stringify({ action: "approve" }), // missing confidence and reasoning
    );

    const response = await plugin.decide(makeRequest("req-incomplete"));

    expect(response).toBeUndefined();
  });

  test("respondedAt is set to a recent timestamp", async () => {
    const before = Date.now();
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => approveJson());

    const response = await plugin.decide(makeRequest("req-timestamp"));

    const after = Date.now();
    expect(response?.respondedAt).toBeGreaterThanOrEqual(before);
    expect(response?.respondedAt).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// AC-5: Unit tests mock adapter.complete() (verified by test structure above)
// — Additional edge case: markdown-wrapped JSON is stripped before parsing
// ---------------------------------------------------------------------------

describe("adapter.complete() response parsing handles markdown-wrapped JSON", () => {
  let plugin: AutoInteractionPlugin;

  beforeEach(async () => {
    plugin = new AutoInteractionPlugin();
    await plugin.init({ confidenceThreshold: 0.7 });
  });

  test("markdown-wrapped JSON is unwrapped and parsed correctly", async () => {
    const wrappedJson = "```json\n" + approveJson(0.95) + "\n```";
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => wrappedJson);

    const response = await plugin.decide(makeRequest("req-markdown"));

    expect(response?.action).toBe("approve");
  });

  test("plain JSON without markdown fences is parsed correctly", async () => {
    (_deps as Record<string, unknown>).adapter = makeAdapter(async () => approveJson(0.88));

    const response = await plugin.decide(makeRequest("req-plain-json"));

    expect(response?.action).toBe("approve");
  });
});
