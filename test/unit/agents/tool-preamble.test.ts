// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { promptWithToolPreamble } from "@/agents/tool-preamble";
import type { AgentRunOptions } from "@/agents/types";

function makeOptions(overrides: Partial<AgentRunOptions> = {}, prompt = "do the thing"): AgentRunOptions {
  return {
    prompt,
    workdir: "/repo",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: makeNaxConfig(),
    ...overrides,
  };
}

const optionsWithTools = makeOptions({
  contextToolRuntime: { callTool: async () => "" },
  contextPullTools: [
    {
      name: "query_neighbor",
      description: "Fetch a neighbouring file",
      inputSchema: { type: "object", properties: {} },
      maxCallsPerSession: 5,
      maxTokensPerCall: 100,
    },
  ],
});

describe("promptWithToolPreamble", () => {
  test("omits the catalogue for native, which receives structured tools instead", () => {
    const prompt = promptWithToolPreamble("native", optionsWithTools);
    expect(prompt).toBe("do the thing");
    expect(prompt).not.toContain("query_neighbor");
  });

  test("still injects the catalogue for an ACP agent", () => {
    const prompt = promptWithToolPreamble("claude", optionsWithTools);
    expect(prompt).toContain("query_neighbor");
  });

  test("leaves a toolless prompt alone on both paths", () => {
    const bare = makeOptions({}, "hi");
    expect(promptWithToolPreamble("native", bare)).toBe("hi");
    expect(promptWithToolPreamble("claude", bare)).toBe("hi");
  });
});
