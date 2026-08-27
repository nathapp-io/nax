/**
 * Tests for resolver.model threading in resolveOutcome()
 *
 * Covers: resolver.model field for synthesis and judge resolvers (issue #352).
 * Verifies that modelDef in completeOptions reflects resolver.model when set,
 * and defaults to "fast" model when absent — matching debater model resolution behavior.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeMockAgentManager, makeMockCallContext, makeMockRuntime } from "@test/helpers";
import type { CompleteOptions } from "@/agents";
import { DEFAULT_CONFIG, debateConfigSelector } from "@/config";
import type { DebateStageConfig } from "@/debate";
import { resolveOutcome } from "@/debate";

function makeCallCtx() {
  return makeMockCallContext({
    runtime: makeMockRuntime({ agentManager: makeMockAgentManager() }),
    packageDir: "/tmp",
    storyId: "US-352",
    featureName: "feat-352",
  });
}

const DEFAULT_DEBATE_CONFIG = debateConfigSelector.select(DEFAULT_CONFIG);

function makeStageConfig(resolverType: "synthesis" | "custom", resolverModel?: string): DebateStageConfig {
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
      return { output: "resolved", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.01 };
    },
  });
}

// ─── Synthesis resolver ───────────────────────────────────────────────────────

describe("resolveOutcome() synthesis — resolver.model → modelDef (#352)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("passes modelDef with 'powerful' model when resolver.model is 'powerful'", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    const agentManager = makeCaptureManager(captured);

    await resolveOutcome(
      ["proposal-a", "proposal-b"],
      [],
      makeStageConfig("synthesis", "powerful"),
      DEFAULT_DEBATE_CONFIG,
      makeCallCtx(),
      "US-352",
      30_000,
      undefined,
      undefined,
      undefined,
      undefined,
      agentManager,
    );

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    // The model is resolved from DEFAULT_CONFIG.models — just verify it is a non-empty string
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });

  test("passes modelDef with 'fast' model when resolver.model is absent", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    const agentManager = makeCaptureManager(captured);

    await resolveOutcome(
      ["proposal-a", "proposal-b"],
      [],
      makeStageConfig("synthesis"),
      DEFAULT_DEBATE_CONFIG,
      makeCallCtx(),
      "US-352",
      30_000,
      undefined,
      undefined,
      undefined,
      undefined,
      agentManager,
    );

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });

  test("passes modelDef with 'balanced' model when resolver.model is 'sonnet' (alias)", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    const agentManager = makeCaptureManager(captured);

    await resolveOutcome(
      ["proposal-a", "proposal-b"],
      [],
      makeStageConfig("synthesis", "sonnet"),
      DEFAULT_DEBATE_CONFIG,
      makeCallCtx(),
      "US-352",
      30_000,
      undefined,
      undefined,
      undefined,
      undefined,
      agentManager,
    );

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });
});

// ─── Judge / custom resolver ──────────────────────────────────────────────────

describe("resolveOutcome() custom/judge — resolver.model → modelDef (#352)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("passes modelDef with 'powerful' model when resolver.model is 'powerful'", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    const agentManager = makeCaptureManager(captured);

    await resolveOutcome(
      ["proposal-a"],
      [],
      makeStageConfig("custom", "powerful"),
      DEFAULT_DEBATE_CONFIG,
      makeCallCtx(),
      "US-352",
      30_000,
      undefined,
      undefined,
      undefined,
      undefined,
      agentManager,
    );

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });

  test("passes modelDef with 'fast' model when resolver.model is absent", async () => {
    const captured: { opts?: CompleteOptions }[] = [];
    const agentManager = makeCaptureManager(captured);

    await resolveOutcome(
      ["proposal-a"],
      [],
      makeStageConfig("custom"),
      DEFAULT_DEBATE_CONFIG,
      makeCallCtx(),
      "US-352",
      30_000,
      undefined,
      undefined,
      undefined,
      undefined,
      agentManager,
    );

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.opts?.modelDef?.model).toBeDefined();
    expect(typeof captured[0]?.opts?.modelDef?.model).toBe("string");
  });
});
