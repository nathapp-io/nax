import { describe, expect, test } from "bun:test";
import type { AgentResult, AgentRunOptions, AgentRunOutcome, AgentRunRequest, HopKind } from "@/agents";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { ContextBundle } from "@/context/engine";

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

describe("AgentRunRequest — executeHop callback", () => {
  test("AgentRunRequest accepts executeHop callback", () => {
    const req: AgentRunRequest = {
      runOptions: makeRunOptions(),
      executeHop: async (_agentName: string, bundle: ContextBundle | undefined, _hopKind: HopKind) => ({
        result: {} as AgentResult,
        bundle,
        prompt: "test",
      }),
    };
    expect(typeof req.executeHop).toBe("function");
  });

  test("AgentRunOutcome has finalBundle and finalPrompt", () => {
    const outcome: AgentRunOutcome = {
      result: {} as AgentResult,
      fallbacks: [],
      finalBundle: undefined,
      finalPrompt: undefined,
    };
    expect(outcome.finalBundle).toBeUndefined();
    expect(outcome.finalPrompt).toBeUndefined();
  });
});
