/**
 * Tests for resolver.model threading in resolveOutcome()
 *
 * Covers: resolver.model field for synthesis and judge resolvers (issue #352).
 * Verifies that modelTier in completeOptions reflects resolver.model when set,
 * and defaults to "fast" when absent — matching debater model resolution behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _debateSessionDeps, resolveOutcome } from "../../../src/debate/session-helpers";
import type { IAgentManager } from "../../../src/agents";
import type { CompleteOptions } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { NaxConfig } from "../../../src/config";

// Tests use undefined config — resolveModelDefForDebater falls back to DEFAULT_CONFIG when config is absent
const NO_CONFIG = undefined as unknown as NaxConfig;

function makeStageConfig(
  resolverType: "synthesis" | "custom",
  resolverModel?: string,
): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: resolverType, agent: "claude", model: resolverModel },
    sessionMode: "one-shot",
    mode: "panel",
    rounds: 1,
    timeoutSeconds: 60,
  } as DebateStageConfig;
}

function makeCaptureManager(captured: { opts?: CompleteOptions }[]): IAgentManager {
  return {
    getAgent: (_name: string) => ({} as any),
    getDefault: () => "claude",
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    events: { on: () => {} } as any,
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async () => ({ result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 1, estimatedCost: 0, agentFallbacks: [] }, fallbacks: [] }),
    completeWithFallback: async () => ({ result: { output: "resolved", costUsd: 0.01, source: "exact" }, fallbacks: [] }),
    run: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 1, estimatedCost: 0, agentFallbacks: [] }),
    complete: async () => ({ output: "resolved", costUsd: 0.01, source: "exact" }),
    completeAs: async (_agentName: string, _prompt: string, opts?: CompleteOptions) => {
      captured.push({ opts });
      return { output: "resolved", costUsd: 0.01, source: "exact" as const };
    },
    runAs: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 1, estimatedCost: 0, agentFallbacks: [] }),
    plan: async () => ({ specContent: "" }),
    planAs: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    decomposeAs: async () => ({ stories: [] }),
  } as any;
}

// ─── Synthesis resolver ───────────────────────────────────────────────────────

describe("resolveOutcome() synthesis — resolver.model → modelTier (#352)", () => {
  let origCreateManager: typeof _debateSessionDeps.createManager;

  beforeEach(() => {
    origCreateManager = _debateSessionDeps.createManager;
  });

  afterEach(() => {
    _debateSessionDeps.createManager = origCreateManager;
    mock.restore();
  });

  test("passes modelTier='powerful' when resolver.model is 'powerful'", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.createManager = mock((_config) => makeCaptureManager(captured));

    await resolveOutcome(["proposal-a", "proposal-b"], [], makeStageConfig("synthesis", "powerful"), NO_CONFIG, "US-352", 30_000);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelTier).toBe("powerful");
  });

  test("passes modelTier='fast' when resolver.model is absent", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.createManager = mock((_config) => makeCaptureManager(captured));

    await resolveOutcome(["proposal-a", "proposal-b"], [], makeStageConfig("synthesis"), NO_CONFIG, "US-352", 30_000);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelTier).toBe("fast");
  });

  test("passes modelTier='balanced' when resolver.model is 'sonnet' (alias)", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.createManager = mock((_config) => makeCaptureManager(captured));

    await resolveOutcome(["proposal-a", "proposal-b"], [], makeStageConfig("synthesis", "sonnet"), NO_CONFIG, "US-352", 30_000);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelTier).toBe("balanced");
  });
});

// ─── Judge / custom resolver ──────────────────────────────────────────────────

describe("resolveOutcome() custom/judge — resolver.model → modelTier (#352)", () => {
  let origCreateManager: typeof _debateSessionDeps.createManager;

  beforeEach(() => {
    origCreateManager = _debateSessionDeps.createManager;
  });

  afterEach(() => {
    _debateSessionDeps.createManager = origCreateManager;
    mock.restore();
  });

  test("passes modelTier='powerful' when resolver.model is 'powerful'", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.createManager = mock((_config) => makeCaptureManager(captured));

    await resolveOutcome(["proposal-a"], [], makeStageConfig("custom", "powerful"), NO_CONFIG, "US-352", 30_000);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelTier).toBe("powerful");
  });

  test("passes modelTier='fast' when resolver.model is absent", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.createManager = mock((_config) => makeCaptureManager(captured));

    await resolveOutcome(["proposal-a"], [], makeStageConfig("custom"), NO_CONFIG, "US-352", 30_000);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelTier).toBe("fast");
  });
});
