import { describe, expect, mock, test } from "bun:test";
import type { CodingTool, ProviderTool, ToolProvider, ToolRunContext } from "@nathapp/nax-agent";
import { toEmbedderTools } from "@/agents/acp";
import { ACP_CHAT_PROVIDER_IDS, chatAcpTools } from "@/chat/acp/acp-tools";
import { buildChatAcpInstructions } from "@/prompts";
import { buildChatAcpInstructions as builderExport } from "@/prompts/builders/chat-builder";

const CTX = { signal: new AbortController().signal, sessionId: "s", toolCallId: "c" };

function tool(localName: string, run?: ProviderTool["run"]): ProviderTool {
  return {
    localName,
    description: `${localName} tool`,
    inputSchema: { type: "object", properties: {} },
    run: run ?? (async () => ({ content: "ok" })),
  };
}

function provider(id: string, tools: readonly ProviderTool[], extra: Partial<ToolProvider> = {}): ToolProvider {
  return { id, kind: "static", stages: ["*"], tools: async () => tools, ...extra };
}

function threeProviders(): ToolProvider[] {
  return [
    provider("nax-workflow", [tool("state"), tool("plan")]),
    provider("nax-jobs", [tool("list"), tool("cancel")]),
    provider("nax-skills", [tool("load")]),
  ];
}

describe("ACP_CHAT_PROVIDER_IDS", () => {
  test("names the workflow and jobs providers only", () => {
    expect([...ACP_CHAT_PROVIDER_IDS]).toEqual(["nax-workflow", "nax-jobs"]);
  });
});

describe("chatAcpTools", () => {
  test("AC-1: delivers only nax-workflow and nax-jobs tools", async () => {
    const { tools } = await chatAcpTools(threeProviders(), "/repo");
    expect(tools.length).toBe(4);
    for (const t of tools) expect(/^(nax-workflow|nax-jobs)__/.test(t.name)).toBe(true);
  });

  test("AC-2: contains nax-workflow__state", async () => {
    const { tools } = await chatAcpTools(threeProviders(), "/repo");
    expect(tools.map((t) => t.name)).toContain("nax-workflow__state");
  });

  test("AC-3: every tool has approval never", async () => {
    const { tools } = await chatAcpTools(threeProviders(), "/repo");
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.approval).toBe("never");
  });

  test("AC-4: a provider whose stages is [chat] still contributes", async () => {
    const providers = [provider("nax-workflow", [tool("state")], { stages: ["chat"] })];
    const { tools } = await chatAcpTools(providers, "/repo");
    expect(tools.map((t) => t.name)).toEqual(["nax-workflow__state"]);
  });

  test("a provider attached to another stage only is not delivered", async () => {
    const providers = [provider("nax-workflow", [tool("state")], { stages: ["run"] })];
    expect((await chatAcpTools(providers, "/repo")).tools).toEqual([]);
  });

  test("AC-5: running a tool calls the provider tool with the input and root /repo", async () => {
    const run = mock(async (_input: Record<string, unknown>, _ctx: ToolRunContext) => ({ content: "done" }));
    const { tools } = await chatAcpTools([provider("nax-workflow", [tool("state", run)])], "/repo");
    const state = tools.find((t) => t.name === "nax-workflow__state");
    const result = await state?.run({ feature: "f" }, CTX);
    expect(result).toEqual({ content: "done" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual({ feature: "f" });
    expect(run.mock.calls[0]?.[1].root).toBe("/repo");
  });

  test("AC-6: a throwing provider tool resolves to an error result", async () => {
    const run = async () => {
      throw new Error("boom");
    };
    const { tools } = await chatAcpTools([provider("nax-workflow", [tool("state", run)])], "/repo");
    expect(await tools[0]?.run({}, CTX)).toEqual({ content: "boom", isError: true });
  });

  test("AC-7: a jobs provider whose tools() rejects is dropped", async () => {
    const broken = provider("nax-jobs", [], {
      tools: async () => {
        throw new Error("down");
      },
    });
    const { tools } = await chatAcpTools([provider("nax-workflow", [tool("state")]), broken], "/repo");
    expect(tools.map((t) => t.name)).toEqual(["nax-workflow__state"]);
  });

  test("AC-8: instructions of both providers are included", async () => {
    const providers = [
      provider("nax-workflow", [tool("state")], { instructions: async () => "W" }),
      provider("nax-jobs", [tool("list")], { instructions: async () => "J" }),
    ];
    const { instructions } = await chatAcpTools(providers, "/repo");
    expect(instructions).toContain("W");
    expect(instructions).toContain("J");
  });

  test("a skills provider's instructions are not delivered", async () => {
    const providers = [
      provider("nax-workflow", [tool("state")], { instructions: async () => "W" }),
      provider("nax-skills", [tool("load")], { instructions: async () => "SKILLS-TEXT" }),
    ];
    const { instructions } = await chatAcpTools(providers, "/repo");
    expect(instructions).toContain("W");
    expect(instructions).not.toContain("SKILLS-TEXT");
  });

  test("AC-9: no instructions means no instructions field", async () => {
    const result = await chatAcpTools(threeProviders(), "/repo");
    expect("instructions" in result).toBe(false);
  });

  test("AC-10: no providers returns { tools: [] }", async () => {
    expect(await chatAcpTools([], "/repo")).toEqual({ tools: [] });
  });
});

describe("buildChatAcpInstructions", () => {
  test("AC-11: names the agent and nax chat", () => {
    const text = buildChatAcpInstructions({ agentLabel: "Codex" });
    expect(text).toContain("Codex");
    expect(text).toContain("nax chat");
  });

  test("AC-12: is mode-neutral", () => {
    const text = buildChatAcpInstructions({ agentLabel: "Codex" });
    expect(text).not.toContain("guarded");
    expect(text).not.toContain("full");
    expect(text.toLowerCase()).not.toContain("unsandboxed");
  });

  test("AC-13: ends with the tool instructions", () => {
    expect(buildChatAcpInstructions({ agentLabel: "Codex", toolInstructions: "T" }).endsWith("T")).toBe(true);
  });

  test("AC-14: the @/prompts export is the builder module's export", () => {
    const input = { agentLabel: "Cursor", toolInstructions: "T" };
    expect(buildChatAcpInstructions(input)).toBe(builderExport(input));
    expect(buildChatAcpInstructions).toBe(builderExport);
  });
});

describe("toEmbedderTools via @/agents/acp", () => {
  test("AC-15: one CodingTool named x__y becomes one embedder tool named x__y", () => {
    const coding: CodingTool = {
      name: "x__y",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => ({ content: "" }),
    };
    const out = toEmbedderTools([coding], "/repo");
    expect(out.length).toBe(1);
    expect(out[0]?.name).toBe("x__y");
  });
});
