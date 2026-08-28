/**
 * nax#1739 — an agent swap on the complete() path must re-resolve the model.
 *
 * `completeWithFallback` captured `options` once and reused it across every hop,
 * so a `claude -> codex` swap dispatched `acpx --model <claude's model> codex`
 * and the ACP agent rejected the model it never advertised. The manager cannot
 * re-resolve on its own — `agentManagerConfigSelector` carries no `models` — so
 * `callOp` injects a per-agent resolver (`modelDefFor`) at the seam that already
 * owns model policy, mirroring the run() path's `pinnedModelAgent` semantics.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeAgentRegistry, makeNaxConfig } from "@test/helpers";
import { AgentManager } from "@/agents/manager";
import type { AgentAdapter, CompleteResult, ResolvedCompleteOptions } from "@/agents/types";
import type { ModelDef } from "@/config";
import { DispatchEventBus } from "@/runtime/dispatch-events";

const CLAUDE_MODEL: ModelDef = { provider: "anthropic", model: "haiku", env: {} };
const CODEX_MODEL: ModelDef = { provider: "openai", model: "gpt-5.6-luna", env: {} };

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

/** Records every ResolvedCompleteOptions the fallback agent's adapter receives. */
function recordingAdapter(seen: ResolvedCompleteOptions[]): AgentAdapter {
  return makeAgentAdapter({
    complete: mock(async (_prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult> => {
      seen.push(options);
      return { output: "codex-out", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    }),
  });
}

function swappingManager(seen: ResolvedCompleteOptions[], dispatchEvents?: DispatchEventBus): AgentManager {
  const primary = failingAvailability();
  const secondary = recordingAdapter(seen);
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
    dispatchEvents ? { dispatchEvents } : undefined,
  );
}

const BASE_OPTS = { modelDef: CLAUDE_MODEL, workdir: "/tmp", storyId: "US-001" };

describe("completeWithFallback model re-resolution (nax#1739)", () => {
  test("AC-1: a swap dispatches the fallback agent with ITS resolved model", async () => {
    const seen: ResolvedCompleteOptions[] = [];
    const modelDefFor = mock((agent: string) => (agent === "claude" ? CLAUDE_MODEL : CODEX_MODEL));

    const outcome = await swappingManager(seen).completeAsWithFallback("claude", "hi", {
      ...BASE_OPTS,
      modelDefFor,
    });

    expect(outcome.result.output).toBe("codex-out");
    expect(seen).toHaveLength(1);
    expect(seen[0].modelDef).toEqual(CODEX_MODEL);
    expect(modelDefFor).toHaveBeenCalledWith("codex");
  });

  test("AC-2: without a resolver the primary's modelDef is still used (back-compat)", async () => {
    const seen: ResolvedCompleteOptions[] = [];

    await swappingManager(seen).completeAsWithFallback("claude", "hi", BASE_OPTS);

    expect(seen).toHaveLength(1);
    expect(seen[0].modelDef).toEqual(CLAUDE_MODEL);
  });

  test("AC-3: a resolver returning undefined for an agent falls back to the primary's modelDef", async () => {
    const seen: ResolvedCompleteOptions[] = [];
    const modelDefFor = mock((_agent: string) => undefined);

    await swappingManager(seen).completeAsWithFallback("claude", "hi", {
      ...BASE_OPTS,
      modelDefFor,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].modelDef).toEqual(CLAUDE_MODEL);
  });

  test("AC-4: the resolver is not consulted when no swap happens", async () => {
    const seen: ResolvedCompleteOptions[] = [];
    const modelDefFor = mock((_agent: string) => CODEX_MODEL);
    const config = makeNaxConfig({ agent: { default: "codex" } });
    const manager = new AgentManager(config, makeAgentRegistry({ getAgent: () => recordingAdapter(seen) }));

    await manager.completeAsWithFallback("codex", "hi", { ...BASE_OPTS, modelDef: CODEX_MODEL, modelDefFor });

    expect(seen).toHaveLength(1);
    expect(seen[0].modelDef).toEqual(CODEX_MODEL);
    expect(modelDefFor).not.toHaveBeenCalled();
  });

  test("AC-8: the complete dispatch event attributes the hop that actually ran", async () => {
    const seen: ResolvedCompleteOptions[] = [];
    const bus = new DispatchEventBus();
    const events: { agentName: string; model?: string }[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "complete") events.push({ agentName: e.agentName, model: e.model });
    });

    await swappingManager(seen, bus).completeAsWithFallback("claude", "hi", {
      ...BASE_OPTS,
      modelDefFor: (agent: string) => (agent === "claude" ? CLAUDE_MODEL : CODEX_MODEL),
    });

    expect(events).toHaveLength(1);
    expect(events[0].agentName).toBe("codex");
    expect(events[0].model).toBe("gpt-5.6-luna");
  });
});
