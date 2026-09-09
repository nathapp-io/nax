// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { applyDiffAccessForAgentProtocol, promptWithToolPreamble } from "@/agents/tool-preamble";
import type { AgentRunOptions } from "@/agents/types";
import { wrapDiffAccess } from "@/prompts/sections/diff-access";
import { wrapAffordance } from "@/prompts/sections/protocol-region";

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

/**
 * US-003 — the dispatch seam must substitute every registered kind, not only
 * diff-access. `run-check` and `run-test` regions produced by
 * self-verification.ts and acceptance-builder.ts reach the agent through this
 * helper; without these tests a regression that reverted the helper to its
 * pre-US-003 behaviour would still pass every other suite in the repo
 * (the kind-registration tests in `protocol-region.test.ts` exercise the
 * renderer in isolation, and the legacy `applyDiffAccess` tests cover the
 * diff-access path). The tests here pin the end-to-end contract: a region
 * written by a builder reaches the agent with the right body for its
 * protocol + advertised tools.
 */
describe("applyDiffAccessForAgentProtocol — run-check / run-test regions (US-003)", () => {
  // AC3 — native + advertised RunCommand ⇒ RunCommand call on the typecheck line.
  test('AC3: native + advertised RunCommand substitutes a run-check region to RunCommand {"command": "typecheck"}', () => {
    const region = wrapAffordance("run-check", { command: "typecheck" }, "`bun x tsc --noEmit`");
    const prompt = `head\n${region}tail`;
    const out = applyDiffAccessForAgentProtocol("native", prompt, ["RunCommand"]);

    expect(out).toContain('RunCommand {"command": "typecheck"}');
    // No shell string leaks through on the native path when RunCommand is advertised.
    expect(out).not.toContain("bun x tsc --noEmit");
    // No marker survives dispatch.
    expect(out).not.toContain("nax:run-check");
  });

  // AC4 — native without RunCommand ⇒ ACP body (the shell string).
  test("AC4: native without RunCommand in advertisedTools keeps the run-check ACP body", () => {
    const region = wrapAffordance("run-check", { command: "typecheck" }, "`bun x tsc --noEmit`");
    const prompt = `head\n${region}tail`;
    const out = applyDiffAccessForAgentProtocol("native", prompt, ["Read", "Glob", "Grep"]);

    expect(out).toContain("bun x tsc --noEmit");
    expect(out).not.toContain("RunCommand");
    expect(out).not.toContain("nax:run-check");
  });

  // ACP path — markers stripped, ACP body kept.
  test("strips a run-check region under ACP, leaving the shell string", () => {
    const region = wrapAffordance("run-check", { command: "typecheck" }, "`bun x tsc --noEmit`");
    const prompt = `head\n${region}tail`;
    const out = applyDiffAccessForAgentProtocol("claude", prompt, ["Git", "Read", "RunCommand"]);

    expect(out).toContain("bun x tsc --noEmit");
    expect(out).not.toContain("RunCommand");
    expect(out).not.toContain("nax:run-check");
  });

  // AC6 — native + advertised RunCommand ⇒ RunCommand call on the rerun line.
  test("AC6: native + advertised RunCommand substitutes a run-test region to the call carrying values.files", () => {
    const region = wrapAffordance(
      "run-test",
      { command: "testScoped", files: "/abs/path.test.ts" },
      "`bun test /abs/path.test.ts`",
    );
    const prompt = `head\n${region}tail`;
    const out = applyDiffAccessForAgentProtocol("native", prompt, ["RunCommand"]);

    expect(out).toContain('RunCommand {"command": "testScoped", "values": {"files": "/abs/path.test.ts"}}');
    expect(out).not.toContain("bun test /abs/path.test.ts");
    expect(out).not.toContain("nax:run-test");
  });

  // Marker hygiene — every registered kind's marker is stripped at dispatch.
  test("strips a run-test region's markers on both protocols", () => {
    const region = wrapAffordance(
      "run-test",
      { command: "testScoped", files: "/abs/path.test.ts" },
      "`bun test /abs/path.test.ts`",
    );
    const prompt = `head\n${region}tail`;
    for (const tools of [["RunCommand"], [], ["Read", "Glob", "Grep"]] as const) {
      for (const agent of ["native", "claude"]) {
        expect(applyDiffAccessForAgentProtocol(agent, prompt, tools)).not.toContain("nax:run-test");
      }
    }
  });
});
