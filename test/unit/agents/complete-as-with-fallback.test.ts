/**
 * nax#1712 — the complete() path's agent-swap records must survive `completeAs`.
 *
 * `completeWithFallback` builds a correct AgentFallbackRecord[], but `completeAs`
 * used to return `outcome.result` and drop it, so every swap taken on the complete()
 * path was invisible to StoryMetrics.fallback.hops. `completeAsWithFallback` is the
 * carrier; `completeAs` is now a thin unwrap over it.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeAgentRegistry, makeMockAgentManager, makeNaxConfig } from "@test/helpers";
import { AgentManager } from "@/agents/manager";
import type { AgentAdapter, CompleteResult } from "@/agents/types";

const MODEL_DEF = { provider: "anthropic", model: "claude-haiku", env: {} } as const;

function completing(output: string): AgentAdapter {
  return makeAgentAdapter({
    complete: mock(
      async (): Promise<CompleteResult> => ({
        output,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.001,
      }),
    ),
  });
}

function failingAvailability(): AgentAdapter {
  return makeAgentAdapter({
    complete: mock(
      async (): Promise<CompleteResult> => ({
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        adapterFailure: {
          outcome: "fail-quota",
          category: "availability",
          retriable: false,
          message: "quota exhausted",
        },
      }),
    ),
  });
}

/** Primary `claude` fails on availability; `codex` succeeds. Fallback enabled. */
function swappingManager(): AgentManager {
  const primary = failingAvailability();
  const secondary = completing("codex-out");
  const config = makeNaxConfig({
    agent: {
      default: "claude",
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: true,
      },
    },
  });
  return new AgentManager(
    config,
    makeAgentRegistry({ getAgent: (name: string) => (name === "claude" ? primary : secondary) }),
  );
}

const OPTS = { modelDef: MODEL_DEF, workdir: "/tmp", storyId: "US-001" };

describe("completeAsWithFallback (nax#1712)", () => {
  test("AC-1: surfaces the swap record and the fallback agent's output", async () => {
    const outcome = await swappingManager().completeAsWithFallback("claude", "hi", OPTS);

    expect(outcome.result.output).toBe("codex-out");
    expect(outcome.fallbacks).toHaveLength(1);
    expect(outcome.fallbacks[0].priorAgent).toBe("claude");
    expect(outcome.fallbacks[0].newAgent).toBe("codex");
  });

  test("AC-2: completeAs still returns the bare CompleteResult", async () => {
    const result = await swappingManager().completeAs("claude", "hi", OPTS);

    expect(result.output).toBe("codex-out");
    expect((result as { fallbacks?: unknown }).fallbacks).toBeUndefined();
  });

  test("AC-7: the swap record carries the storyId from the call's options", async () => {
    const outcome = await swappingManager().completeAsWithFallback("claude", "hi", OPTS);

    expect(outcome.fallbacks[0].storyId).toBe("US-001");
  });
});

describe("makeMockAgentManager gains completeAsWithFallback (nax#1712)", () => {
  test("AC-6: default mock resolves an outcome instead of throwing", async () => {
    const mgr = makeMockAgentManager();

    const outcome = await mgr.completeAsWithFallback("claude", "hi", OPTS);

    expect(outcome.result).toBeDefined();
    expect(outcome.fallbacks).toEqual([]);
  });

  test("AC-6: a completeAsFn override supplies the outcome's result", async () => {
    const mgr = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "overridden",
        tokenUsage: { inputTokens: 1, outputTokens: 2 },
        estimatedCostUsd: 0.5,
      }),
    });

    const outcome = await mgr.completeAsWithFallback("claude", "hi", OPTS);

    expect(outcome.result.output).toBe("overridden");
  });
});
