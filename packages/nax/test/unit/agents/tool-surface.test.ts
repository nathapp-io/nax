/**
 * #2410/#2444 — the tool-surface record builders and the ACP delivery filter.
 *
 * The draft is the transport-less evidence of what a session was offered; the
 * record stamps transport (and, on ACP, the narrowed profile). The delivery
 * filter is the one enforcement point for Mcp deny/ask rules on the ACP path
 * (claude pre-approval means those calls never reach a permission round trip).
 */
import { describe, expect, test } from "bun:test";
import type { CodingTool, ResolvedProviderTools } from "@nathapp/nax-agent";
import { buildToolSurfaceDraft, filterAcpDelivery, finishToolSurface } from "@/agents/tool-surface";

function providerResult(over: Partial<ResolvedProviderTools> = {}): ResolvedProviderTools {
  return {
    tools: [],
    grants: [],
    failures: [],
    skipped: [],
    withheld: [],
    providerIdByTool: new Map(),
    entries: [],
    ...over,
  };
}

describe("buildToolSurfaceDraft", () => {
  test("maps entries, withheld, skipped and failures into the draft", () => {
    const draft = buildToolSurfaceDraft({
      stage: "review",
      declaredTools: ["Read", "Glob", "Grep"],
      providerResult: providerResult({
        entries: [{ providerId: "codegraph", localNames: ["search_graph"] }],
        withheld: [{ providerId: "codegraph", localName: "write_graph", reason: "not-admitted" }],
        skipped: [{ providerId: "runonly", reason: "stage-mismatch", stages: ["run"] }],
        failures: [{ providerId: "broken", reason: "connect EREFUSED" }],
      }),
    });
    expect(draft).toEqual({
      stage: "review",
      declaredTools: ["Read", "Glob", "Grep"],
      advertised: [{ providerId: "codegraph", names: ["search_graph"] }],
      withheld: [{ providerId: "codegraph", name: "write_graph", reason: "not-admitted" }],
      skippedProviders: [{ id: "runonly", reason: "stage-mismatch", stages: ["run"] }],
      failures: [{ providerId: "broken", reason: "connect EREFUSED" }],
    });
  });

  test("entries with no surviving names are not advertised", () => {
    const draft = buildToolSurfaceDraft({
      stage: "run",
      declaredTools: [],
      providerResult: providerResult({ entries: [{ providerId: "codegraph", localNames: [] }] }),
    });
    expect(draft.advertised).toEqual([]);
  });

  test("provider-scope:none is recorded as a whole-layer skip", () => {
    const draft = buildToolSurfaceDraft({
      stage: "run",
      declaredTools: ["Read"],
      providerResult: providerResult(),
      extraSkipped: [{ id: "*", reason: "provider-scope:none" }],
    });
    expect(draft.skippedProviders).toEqual([{ id: "*", reason: "provider-scope:none" }]);
  });

  test("extra withheld (deny/ask-ruled) merges after the not-admitted rows", () => {
    const draft = buildToolSurfaceDraft({
      stage: "review",
      declaredTools: [],
      providerResult: providerResult({
        withheld: [{ providerId: "cg", localName: "a", reason: "not-admitted" }],
      }),
      extraWithheld: [{ providerId: "cg", name: "b", reason: "denied" }],
    });
    expect(draft.withheld).toEqual([
      { providerId: "cg", name: "a", reason: "not-admitted" },
      { providerId: "cg", name: "b", reason: "denied" },
    ]);
  });
});

describe("finishToolSurface", () => {
  test("stamps transport and profile onto the draft", () => {
    const draft = buildToolSurfaceDraft({ stage: "review", declaredTools: [], providerResult: providerResult() });
    const record = finishToolSurface(draft, "acp", "read");
    expect(record.transport).toBe("acp");
    expect(record.profile).toBe("read");
    expect(record.stage).toBe("review");
  });

  test("native stamping omits the profile", () => {
    const draft = buildToolSurfaceDraft({ stage: "run", declaredTools: [], providerResult: providerResult() });
    const record = finishToolSurface(draft, "native");
    expect(record.transport).toBe("native");
    expect("profile" in record).toBe(false);
  });
});

describe("filterAcpDelivery", () => {
  const tool = (name: string): CodingTool =>
    ({
      name,
      description: "d",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => ({ content: "" }),
    }) as CodingTool;

  const result = providerResult({
    tools: [tool("codegraph__search_graph"), tool("codegraph__write_graph"), tool("other__probe")],
    providerIdByTool: new Map([
      ["codegraph__search_graph", "codegraph"],
      ["codegraph__write_graph", "codegraph"],
      ["other__probe", "other"],
    ]),
  });

  test("keeps rule-free tools", () => {
    const { tools, withheldExtra } = filterAcpDelivery(result, { deniedMcp: [], askedMcp: [] });
    expect(tools.map((t) => t.name)).toEqual(["codegraph__search_graph", "codegraph__write_graph", "other__probe"]);
    expect(withheldExtra).toEqual([]);
  });

  test("drops a server-denied tool with reason denied", () => {
    const { tools, withheldExtra } = filterAcpDelivery(result, { deniedMcp: ["codegraph"], askedMcp: [] });
    expect(tools.map((t) => t.name)).toEqual(["other__probe"]);
    expect(withheldExtra).toEqual([
      { providerId: "codegraph", name: "search_graph", reason: "denied" },
      { providerId: "codegraph", name: "write_graph", reason: "denied" },
    ]);
  });

  test("drops a tool-scoped ask-ruled tool with reason ask-ruled", () => {
    const { tools, withheldExtra } = filterAcpDelivery(result, {
      deniedMcp: [],
      askedMcp: ["codegraph:write_graph"],
    });
    expect(tools.map((t) => t.name)).toEqual(["codegraph__search_graph", "other__probe"]);
    expect(withheldExtra).toEqual([{ providerId: "codegraph", name: "write_graph", reason: "ask-ruled" }]);
  });
});
