import { describe, expect, test } from "bun:test";
import type { AgentRunRequest, AgentRunOutcome, HopKind } from "../../../src/agents/manager-types";
import type { ContextBundle } from "../../../src/context/engine";
import type { AgentResult } from "../../../src/agents/types";

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
