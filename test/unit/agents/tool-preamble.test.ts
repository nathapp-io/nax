// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { applyDiffAccessForAgent, promptWithToolPreamble } from "@/agents/tool-preamble";
import type { AgentRunOptions } from "@/agents/types";
import { wrapDiffAccess } from "@/prompts/diff-access";

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

/**
 * #1800 — the protocol branch has to happen here, not in the builders:
 * `operations/call.ts:55` joins the prompt before `:69` resolves the dispatch
 * agent, and a fallback swap can change the protocol afterwards.
 */
describe("applyDiffAccessForAgent", () => {
  const region = wrapDiffAccess({ ref: "abc123", fullExclude: [".", ":!.nax/"] }, "SHELL BODY\n");
  const prompt = `head\n${region}tail`;

  test("renders tool-shaped instructions for native", () => {
    const out = applyDiffAccessForAgent("native", prompt);
    expect(out).toContain('"subcommand":"diff"');
    expect(out).not.toContain("SHELL BODY");
  });

  test("keeps the shell body for an ACP agent", () => {
    const out = applyDiffAccessForAgent("claude", prompt);
    expect(out).toContain("SHELL BODY");
    expect(out).not.toContain('"subcommand":"diff"');
  });

  test("strips the markers on both paths, so neither agent ever sees one", () => {
    for (const agent of ["native", "claude"]) {
      expect(applyDiffAccessForAgent(agent, prompt)).not.toContain("nax:diff-access");
    }
  });
});
