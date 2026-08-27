/**
 * nax#1722 follow-up: `agent.fallback.maxHopsPerStory` is documented — in
 * `src/cli/config-descriptions.ts` and in SPEC-context-engine-agent-fallback — as a
 * per-STORY budget, but `hopsSoFar` was local to a single `runWithFallback` call, so
 * it actually bounded swaps per OPERATION. A story running N ops could take N x cap
 * hops. The budget is now keyed by storyId across every op of a story.
 *
 * A per-story budget alone would strand later ops on a dead primary, because
 * `getDefault()` ignores availability and every op re-probes the primary. So the
 * budget is paired with the dead-primary skip: an op whose primary is already known
 * unavailable starts on the first live fallback instead, consuming no hop.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { AgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { AdapterFailure } from "@/context/engine";

const availFailure: AdapterFailure = {
  category: "availability" as const,
  outcome: "fail-auth" as const,
  retriable: false,
  message: "",
};

function makeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
    ...overrides,
  };
}

function configWithFallback(overrides: { maxHopsPerStory?: number; enabled?: boolean } = {}) {
  return makeNaxConfig({
    agent: {
      fallback: {
        enabled: overrides.enabled ?? true,
        map: { claude: ["codex", "gemini"] },
        maxHopsPerStory: overrides.maxHopsPerStory ?? 1,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
  });
}

/**
 * `fail-auth` is sticky for the whole run; `fail-service-down` is cleared by
 * `resetTransientUnavailable()` at a story boundary, which is what a test needs when it
 * wants the next story to start on the primary again rather than on the dead-primary skip.
 */
const transientFailure: AdapterFailure = { ...availFailure, outcome: "fail-service-down" };

/** Hop runner where every named agent succeeds and everything else fails availability. */
function makeRunHop(succeeding: string[], failure: AdapterFailure = availFailure) {
  return async (name: string) => ({
    prompt: `prompt-${name}`,
    result: succeeding.includes(name)
      ? { success: true, exitCode: 0, output: `ok-${name}`, rateLimited: false, durationMs: 1, estimatedCostUsd: 0 }
      : {
          success: false,
          exitCode: 1,
          output: "auth failure",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          adapterFailure: failure,
        },
  });
}

describe("AgentManager — per-story hop budget", () => {
  test("hops spend a budget shared across a story's operations", async () => {
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, {
      runHop: makeRunHop(["codex"]),
    });

    const first = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-001" }) });
    expect(first.result.success).toBe(true);
    expect(first.fallbacks).toHaveLength(1);

    // Second op of the SAME story: the budget is spent. codex is now the effective
    // primary (dead-primary skip), so the op still runs — but it cannot swap again.
    const second = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-001" }) });
    expect(second.result.success).toBe(true);
    expect(second.fallbacks).toHaveLength(0);
  });

  test("a spent budget stops further swaps within the story", async () => {
    // Nothing succeeds: the first op spends the single hop, the second must not swap.
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, { runHop: makeRunHop([]) });

    const first = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-002" }) });
    expect(first.fallbacks).toHaveLength(1);

    const second = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-002" }) });
    expect(second.fallbacks).toHaveLength(0);
  });

  test("a different story gets its own budget", async () => {
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, {
      runHop: makeRunHop(["codex"], transientFailure),
    });

    await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-003" }) });
    // Story boundary: the transient unavailability clears, so us-004 starts on the
    // primary again and its own budget lets it swap.
    m.resetTransientUnavailable();

    const other = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-004" }) });
    expect(other.fallbacks).toHaveLength(1);
  });

  test("calls with no storyId keep a per-call budget", async () => {
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, {
      runHop: makeRunHop(["codex"], transientFailure),
    });

    const first = await m.runWithFallback({ runOptions: makeRunOptions() });
    expect(first.fallbacks).toHaveLength(1);
    m.resetTransientUnavailable();

    const second = await m.runWithFallback({ runOptions: makeRunOptions() });
    expect(second.fallbacks).toHaveLength(1);
  });

  test("reset() clears the budget", async () => {
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, {
      runHop: makeRunHop(["codex"]),
    });

    await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-005" }) });
    m.reset();

    const after = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-005" }) });
    expect(after.fallbacks).toHaveLength(1);
  });
});

describe("AgentManager — dead-primary skip", () => {
  test("an op whose primary is already unavailable starts on the fallback, spending no hop", async () => {
    const m = new AgentManager(configWithFallback(), undefined, { runHop: makeRunHop(["codex"]) });
    m.markUnavailable("claude", availFailure);

    const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-006" }) });

    expect(outcome.result.output).toBe("ok-codex");
    expect(outcome.fallbacks).toHaveLength(0);
    expect(outcome.finalAgent).toBe("codex");
  });

  test("the chain still walks from the configured primary after a skip", async () => {
    // codex is dead too — the swap from the substituted start must find gemini,
    // which only map["claude"] lists.
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 2 }), undefined, {
      runHop: makeRunHop(["gemini"]),
    });
    m.markUnavailable("claude", availFailure);

    const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-007" }) });

    expect(outcome.result.output).toBe("ok-gemini");
    expect(outcome.finalAgent).toBe("gemini");
    expect(outcome.fallbacks).toHaveLength(1);
  });

  test("no skip when fallback is disabled", async () => {
    const m = new AgentManager(configWithFallback({ enabled: false }), undefined, { runHop: makeRunHop(["codex"]) });
    m.markUnavailable("claude", availFailure);

    const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-008" }) });

    expect(outcome.result.success).toBe(false);
    expect(outcome.finalAgent).toBe("claude");
  });
});
