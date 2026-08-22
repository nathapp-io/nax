import { describe, expect, test } from "bun:test";
import type { AgentResult, AgentRunOutcome, AgentRunRequest, HopKind } from "@/agents";
import type { ContextBundle } from "@/context/engine";

describe("AgentRunRequest — executeHop callback", () => {
  test("AgentRunRequest accepts executeHop callback", () => {
    const req: AgentRunRequest = {
      runOptions: {} as never,
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
