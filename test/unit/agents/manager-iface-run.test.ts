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
import { makeAgentAdapter, makeNaxConfig } from "../../../test/helpers";

function makeConfig(fallbackEnabled = false): NaxConfig {
  return makeNaxConfig({
    agent: {
      default: "claude",
      fallback: {
        enabled: fallbackEnabled,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: true,
      },
    },
  });
}

function makeAdapter(name: string, success = true): AgentAdapter {
  return makeAgentAdapter({
    name,
    displayName: name,
    binary: name,
    capabilities: { supportedTiers: ["fast"], maxContextTokens: 100000, features: new Set() },
    run: mock(async () => ({
      success,
      exitCode: success ? 0 : 1,
      output: success ? "ok" : "",
      rateLimited: false,
      durationMs: 10,
      estimatedCost: 0.001,
    })),
    complete: mock(async () => ({ output: "complete-out", costUsd: 0.001, source: "cache" as const })),
    closeSession: async () => {},
    closePhysicalSession: async () => {},
    deriveSessionName: () => `nax-test-${name}`,
    isInstalled: async () => true,
    buildCommand: () => [],
    plan: async () => ({ success: true, spec: "" }),
    decompose: async () => ({ success: true, stories: [] }),
  });
}

function makeRegistry(adapters: AgentAdapter[]) {
  const map = new Map(adapters.map((a) => [a.name, a]));
  return { getAgent: (name: string) => map.get(name) };
}

describe("IAgentManager.run()", () => {
  test("delegates to runWithFallback and returns AgentResult", async () => {
    const adapter = makeAdapter("claude");
    const mgr = new AgentManager(makeConfig(), makeRegistry([adapter]) as never);

    const request: AgentRunRequest = {
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "m", env: {} },
        timeoutSeconds: 30,
        config: makeConfig(),
      },
    };

    const result = await mgr.run(request);

    expect(result.success).toBe(true);
    expect(result.output).toBe("ok");
  });

  test("copies fallback records into result.agentFallbacks on success", async () => {
    const adapter = makeAdapter("claude");
    const mgr = new AgentManager(makeConfig(), makeRegistry([adapter]) as never);

    const result = await mgr.run({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "m", env: {} },
        timeoutSeconds: 30,
        config: makeConfig(),
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
    const claudeAdapter = makeAdapter("claude", false);
    const codexAdapter = makeAdapter("codex", true);

    (claudeAdapter.run as ReturnType<typeof mock>).mockImplementation(async () => ({
      success: false,
      exitCode: 1,
      output: "",
      rateLimited: false,
      durationMs: 10,
      estimatedCost: 0,
      adapterFailure: { category: "availability", outcome: "fail-auth", retriable: false, message: "" },
    }));

    const mgr = new AgentManager(makeConfig(true), makeRegistry([claudeAdapter, codexAdapter]) as never);
    _agentManagerDeps.sleep = mock(async () => {});

    const result = await mgr.run({
      runOptions: {
        prompt: "test",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "m", env: {} },
        timeoutSeconds: 30,
        config: makeConfig(true),
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
    const adapter = makeAdapter("claude");
    const mgr = new AgentManager(makeConfig(), makeRegistry([adapter]) as never);

    const result = await mgr.complete("hello", {
      model: "claude-haiku",
      config: makeConfig(),
      workdir: "/tmp",
    });

    expect(result.output).toBe("complete-out");
  });
});

describe("IAgentManager.getAgent()", () => {
  test("returns the adapter for a known agent name", () => {
    const adapter = makeAdapter("claude");
    const mgr = new AgentManager(makeConfig(), makeRegistry([adapter]) as never);

    expect(mgr.getAgent("claude")).toBe(adapter);
  });

  test("returns undefined for an unknown agent name", () => {
    const mgr = new AgentManager(makeConfig(), makeRegistry([]) as never);

    expect(mgr.getAgent("nonexistent")).toBeUndefined();
  });

  test("lazily creates registry and returns adapter when no explicit registry is provided (Phase 4)", () => {
    const mgr = new AgentManager(makeConfig());
    expect(mgr.getAgent("claude")).not.toBeUndefined();
  });
});
