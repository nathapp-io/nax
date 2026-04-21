/**
 * Integration test — ADR-013 Phase 6 AgentManager lifetime / unavailability threading
 *
 * Demonstrates the invariant: a shared manager carries unavailability state across
 * rectification retries, allowing already-failed fallback agents to be skipped.
 *
 * A fresh manager (the pre-Phase-6B behaviour) starts with empty _unavailable, so
 * it re-tries agents that the canonical run already exhausted — one wasted hop per call.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import type { AgentResult } from "../../../src/agents/types";
import type { AdapterFailure } from "../../../src/context/engine/types";
import { makeNaxConfig } from "../../helpers/mock-nax-config";

// adapterFailure that triggers a swap (category: "availability" → shouldSwap() returns true).
const AUTH_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-auth",
  retriable: false,
  message: "401 Unauthorized",
};

// Minimal truthy ContextBundle — only needed for shouldSwap's `if (!bundle) return false` guard.
// Cast to satisfy the TypeScript type; none of the fields are read by shouldSwap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_BUNDLE = { pushMarkdown: "", pullTools: [], digest: "", manifest: {}, chunks: [] } as any;

function makeFailResult(): AgentResult {
  return {
    success: false,
    exitCode: 1,
    output: "auth error",
    rateLimited: false,
    durationMs: 0,
    estimatedCost: 0,
    adapterFailure: AUTH_FAILURE,
  };
}

function makeSuccessResult(): AgentResult {
  return { success: true, exitCode: 0, output: "ok", rateLimited: false, durationMs: 0, estimatedCost: 0 };
}

// Config: claude (primary) → [codex, gemini] fallback chain, 3-hop budget.
function makeFallbackConfig() {
  return makeNaxConfig({
    agent: {
      default: "claude",
      fallback: {
        enabled: true,
        map: { claude: ["codex", "gemini"] },
        maxHopsPerStory: 3,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
  });
}

// Minimal AgentRunOptions — runOptions is threaded through but never used by executeHop.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STUB_RUN_OPTIONS = { prompt: "fix it", workdir: "/tmp", storyId: "US-001" } as any;

describe("ADR-013 Phase 6 — manager unavailability state threading", () => {
  let config: ReturnType<typeof makeFallbackConfig>;

  beforeEach(() => {
    config = makeFallbackConfig();
  });

  test("shared manager skips previously-failed fallback agent (Phase 6B invariant)", async () => {
    const manager = new AgentManager(config);

    // Simulate: canonical run already hit codex and marked it unavailable.
    manager.markUnavailable("codex", AUTH_FAILURE);

    const agentsTried: string[] = [];

    // executeHop captures which agent each hop targets and controls the outcome.
    const result = await manager.run({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: async (agentName) => {
        agentsTried.push(agentName);
        // claude and codex fail; gemini succeeds.
        const res = agentName === "gemini" ? makeSuccessResult() : makeFailResult();
        return { result: res, bundle: STUB_BUNDLE };
      },
    });

    // claude is tried (primary), codex is SKIPPED (already unavailable),
    // gemini is tried and succeeds — 2 hops, not 3.
    expect(agentsTried).toEqual(["claude", "gemini"]);
    expect(result.success).toBe(true);
  });

  test("fresh manager re-tries previously-failed fallback agent (pre-Phase-6B behaviour)", async () => {
    const freshManager = new AgentManager(config);
    // No prior unavailability state — codex is not marked.

    const agentsTried: string[] = [];

    const result = await freshManager.run({
      runOptions: STUB_RUN_OPTIONS,
      bundle: STUB_BUNDLE,
      executeHop: async (agentName) => {
        agentsTried.push(agentName);
        const res = agentName === "gemini" ? makeSuccessResult() : makeFailResult();
        return { result: res, bundle: STUB_BUNDLE };
      },
    });

    // Fresh manager doesn't know codex is bad — tries claude → codex → gemini.
    // The codex hop is the wasted attempt that Phase 6B eliminates by threading the manager.
    expect(agentsTried).toEqual(["claude", "codex", "gemini"]);
    expect(result.success).toBe(true);
  });

  test("isUnavailable reflects markUnavailable across calls on the same manager", () => {
    const manager = new AgentManager(config);

    expect(manager.isUnavailable("claude")).toBe(false);
    manager.markUnavailable("claude", AUTH_FAILURE);
    expect(manager.isUnavailable("claude")).toBe(true);

    // reset() clears unavailability — only called at run boundaries.
    manager.reset();
    expect(manager.isUnavailable("claude")).toBe(false);
  });

  test("nextCandidate skips unavailable agents in the fallback chain", () => {
    const manager = new AgentManager(config);

    // With codex unavailable: claude→[codex(skip), gemini] → gemini is next.
    manager.markUnavailable("codex", AUTH_FAILURE);
    expect(manager.nextCandidate("claude", 0)).toBe("gemini");

    // With both unavailable: no candidate left.
    manager.markUnavailable("gemini", AUTH_FAILURE);
    expect(manager.nextCandidate("claude", 0)).toBeNull();
  });
});
