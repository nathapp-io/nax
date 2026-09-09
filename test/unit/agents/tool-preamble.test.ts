// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { applyDiffAccessForAgentProtocol, promptWithToolPreamble } from "@/agents/tool-preamble";
import type { AgentRunOptions } from "@/agents/types";
import { wrapDiffAccess } from "@/prompts/sections/diff-access";

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
 *
 * US-002 — the third argument is REQUIRED. The advertised tool list is the
 * gate; a caller that cannot know it must explicitly pass it, and a caller
 * that knows it must pass exactly the set the agent will see at dispatch.
 * Tests use `["Git", "Read"]` for "native + advertised" and the empty list
 * for "native + no tools" — these are the two ends of the gate AC3/AC4 cover.
 */
describe("applyDiffAccessForAgentProtocol", () => {
  const region = wrapDiffAccess({ ref: "abc123", fullExclude: [".", ":!.nax/"] }, "SHELL BODY\n");
  const prompt = `head\n${region}tail`;

  // AC3 — native + advertised Git + Read ⇒ native rendering.
  test("AC3: native with advertised Git and Read renders the tool-shaped diff instructions", () => {
    const out = applyDiffAccessForAgentProtocol("native", prompt, ["Git", "Read"]);
    expect(out).toContain('"subcommand":"diff"');
    expect(out).not.toContain("SHELL BODY");
  });

  // AC4 — native + empty advertised list ⇒ ACP body.
  test("AC4: native with an empty advertised-tool list keeps the shell body", () => {
    const out = applyDiffAccessForAgentProtocol("native", prompt, []);
    expect(out).toContain("SHELL BODY");
    expect(out).not.toContain('"subcommand":"diff"');
  });

  // Boundary — native with only Read advertised (no Git) ⇒ ACP body.
  test("AC4: native with advertised tools that omit Git keeps the shell body", () => {
    const out = applyDiffAccessForAgentProtocol("native", prompt, ["Read", "Glob", "Grep"]);
    expect(out).toContain("SHELL BODY");
    expect(out).not.toContain('"subcommand":"diff"');
  });

  // Boundary — native with only Git advertised (no Read) ⇒ ACP body.
  test("AC4: native with advertised tools that omit Read keeps the shell body", () => {
    const out = applyDiffAccessForAgentProtocol("native", prompt, ["Git"]);
    expect(out).toContain("SHELL BODY");
    expect(out).not.toContain('"subcommand":"diff"');
  });

  // ACP path is unchanged — agent is non-native, advertisedTools is irrelevant.
  test("keeps the shell body for an ACP agent regardless of advertised tools", () => {
    expect(applyDiffAccessForAgentProtocol("claude", prompt, ["Git", "Read"])).toContain("SHELL BODY");
    expect(applyDiffAccessForAgentProtocol("claude", prompt, [])).toContain("SHELL BODY");
    expect(applyDiffAccessForAgentProtocol("claude", prompt, ["Read", "Glob", "Grep"])).toContain("SHELL BODY");
  });

  // Marker hygiene — neither agent ever sees a marker, regardless of gating.
  test("strips the markers on both paths, so neither agent ever sees one", () => {
    for (const tools of [["Git", "Read"], [], ["Read", "Glob", "Grep"]] as const) {
      for (const agent of ["native", "claude"]) {
        expect(applyDiffAccessForAgentProtocol(agent, prompt, tools)).not.toContain("nax:diff-access");
      }
    }
  });
});
