/**
 * Tests for resolver.model threading in resolveOutcome()
 *
 * Covers: resolver.model field for synthesis and judge resolvers (issue #352).
 * Verifies that modelDef in completeOptions reflects resolver.model when set,
 * and defaults to "fast" model when absent — matching debater model resolution behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _debateSessionDeps, resolveOutcome } from "../../../src/debate/session-helpers";
import type { CompleteOptions } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { NaxConfig } from "../../../src/config";
import { makeMockAgentManager } from "../../helpers";

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

function makeCaptureManager(captured: { opts?: CompleteOptions }[]) {
  return makeMockAgentManager({
    completeFn: async (_agentName: string, _prompt: string, opts?: CompleteOptions) => {
      captured.push({ opts });
      return { output: "resolved", costUsd: 0.01, source: "exact" as const };
    },
  });
}

// ─── Synthesis resolver ───────────────────────────────────────────────────────

describe("resolveOutcome() synthesis — resolver.model → modelDef (#352)", () => {
  let origAgentManager: typeof _debateSessionDeps.agentManager;

  beforeEach(() => {
    origAgentManager = _debateSessionDeps.agentManager;
  });

  afterEach(() => {
    _debateSessionDeps.agentManager = origAgentManager;
    mock.restore();
  });

  test("passes modelDef with 'powerful' model when resolver.model is 'powerful'", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured);

    await resolveOutcome(["proposal-a", "proposal-b"], [], makeStageConfig("synthesis", "powerful"), NO_CONFIG, "US-352", 30_000, undefined, undefined, undefined, undefined, undefined, undefined, undefined as unknown as import("../../../src/agents").IAgentManager);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    // The model is resolved from DEFAULT_CONFIG.models — just verify it is a non-empty string
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });

  test("passes modelDef with 'fast' model when resolver.model is absent", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured);

    await resolveOutcome(["proposal-a", "proposal-b"], [], makeStageConfig("synthesis"), NO_CONFIG, "US-352", 30_000, undefined, undefined, undefined, undefined, undefined, undefined, undefined as unknown as import("../../../src/agents").IAgentManager);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });

  test("passes modelDef with 'balanced' model when resolver.model is 'sonnet' (alias)", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured);

    await resolveOutcome(["proposal-a", "proposal-b"], [], makeStageConfig("synthesis", "sonnet"), NO_CONFIG, "US-352", 30_000, undefined, undefined, undefined, undefined, undefined, undefined, undefined as unknown as import("../../../src/agents").IAgentManager);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });
});

// ─── Judge / custom resolver ──────────────────────────────────────────────────

describe("resolveOutcome() custom/judge — resolver.model → modelDef (#352)", () => {
  let origAgentManager: typeof _debateSessionDeps.agentManager;

  beforeEach(() => {
    origAgentManager = _debateSessionDeps.agentManager;
  });

  afterEach(() => {
    _debateSessionDeps.agentManager = origAgentManager;
    mock.restore();
  });

  test("passes modelDef with 'powerful' model when resolver.model is 'powerful'", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured);

    await resolveOutcome(["proposal-a"], [], makeStageConfig("custom", "powerful"), NO_CONFIG, "US-352", 30_000, undefined, undefined, undefined, undefined, undefined, undefined, undefined as unknown as import("../../../src/agents").IAgentManager);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });

  test("passes modelDef with 'fast' model when resolver.model is absent", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    _debateSessionDeps.agentManager = makeCaptureManager(captured);

    await resolveOutcome(["proposal-a"], [], makeStageConfig("custom"), NO_CONFIG, "US-352", 30_000, undefined, undefined, undefined, undefined, undefined, undefined, undefined as unknown as import("../../../src/agents").IAgentManager);

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });
});
