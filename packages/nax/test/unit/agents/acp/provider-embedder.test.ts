/**
 * #2444 D1/D3 — CodingTool → EmbedderTool adaptation for provider tools served
 * over the ACP loopback host, and the capability gate that keeps delivery
 * claude-only (the registry's preApproval channel) while recording the skip.
 */
import { describe, expect, test } from "bun:test";
import type { CodingTool, OpenSessionOpts, ToolSurfaceDraft } from "@nathapp/nax-agent";
import { finalizeAcpSurface, toEmbedderTools } from "@/agents/acp/provider-embedder";

const CODING_TOOL: CodingTool = {
  name: "context7__query-docs",
  description: "query docs",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  scope: { pathFields: [] },
  run: async () => ({ content: "ok" }),
};

const DRAFT: ToolSurfaceDraft = {
  stage: "review",
  declaredTools: ["Read", "Glob", "Grep"],
  advertised: [{ providerId: "context7", names: ["query-docs"] }],
  withheld: [],
  skippedProviders: [{ id: "runonly", reason: "stage-mismatch", stages: ["run"] }],
  failures: [],
};

function optsWith(over: Partial<OpenSessionOpts>): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: "/repo",
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "sonnet" },
    timeoutSeconds: 600,
    ...over,
  };
}

describe("toEmbedderTools", () => {
  test("maps name, description, schema and approval never", () => {
    const [tool] = toEmbedderTools([CODING_TOOL], "/repo");
    expect(tool?.name).toBe("context7__query-docs");
    expect(tool?.description).toBe("query docs");
    expect(tool?.inputSchema).toEqual(CODING_TOOL.inputSchema);
    expect(tool?.approval).toBe("never");
  });

  test("run reaches the coding tool and maps the result", async () => {
    const [tool] = toEmbedderTools([CODING_TOOL], "/repo");
    const result = await tool?.run({ q: "x" }, { sessionId: "s", toolCallId: "c1", signal: new AbortController().signal });
    expect(result).toEqual({ content: "ok" });
  });

  test("a throwing tool run reaches the model as an error, not a crash (Review Focus 5)", async () => {
    const throwing: CodingTool = { ...CODING_TOOL, run: async () => { throw new Error("boom"); } };
    const [tool] = toEmbedderTools([throwing], "/repo");
    const result = await tool?.run({}, { sessionId: "s", toolCallId: "c1", signal: new AbortController().signal });
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("boom");
  });
});

describe("finalizeAcpSurface (D3 claude-only delivery)", () => {
  test("claude: tools delivered and the surface stamped acp + narrowed profile", () => {
    const { tools, surface } = finalizeAcpSurface("claude", optsWith({ providerTools: [CODING_TOOL], toolSurface: DRAFT }), "read");
    expect(tools.map((tool) => tool.name)).toEqual(["context7__query-docs"]);
    expect(surface?.transport).toBe("acp");
    expect(surface?.profile).toBe("read");
    expect(surface?.advertised).toEqual(DRAFT.advertised);
  });

  test("codex: no pre-approval channel — tools dropped, the skip recorded, advertised emptied", () => {
    const { tools, surface } = finalizeAcpSurface("codex", optsWith({ providerTools: [CODING_TOOL], toolSurface: DRAFT }), "full");
    expect(tools).toEqual([]);
    expect(surface?.advertised).toEqual([]);
    expect(surface?.skippedProviders).toContainEqual({ id: "codex", reason: "mcp-pre-approval-unsupported" });
    expect(surface?.transport).toBe("acp");
  });

  test("no draft: nothing delivered, nothing recorded", () => {
    const { tools, surface } = finalizeAcpSurface("claude", optsWith({}), "full");
    expect(tools).toEqual([]);
    expect(surface).toBeUndefined();
  });
});
