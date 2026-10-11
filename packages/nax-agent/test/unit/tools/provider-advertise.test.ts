import { describe, expect, test } from "bun:test";
import { resolveProviderTools } from "#src/tools/provider-advertise";
import type { ProviderTool, ToolProvider } from "#src/tools/provider-types";

function provider(over: Partial<ToolProvider> = {}): ToolProvider {
  const seen: string[] = [];
  return {
    id: "fake",
    kind: "static",
    stages: ["run"],
    tools: async (workdir: string) => {
      seen.push(workdir);
      return [
        {
          localName: "probe",
          description: workdir,
          inputSchema: { type: "object", properties: {} },
          run: async () => ({ content: workdir }),
        } satisfies ProviderTool,
      ];
    },
    ...over,
  };
}

describe("resolveProviderTools", () => {
  test("advertises a provider attached to this stage", async () => {
    const { tools, grants, providerIdByTool } = await resolveProviderTools([provider()], "run", "/w/a");
    expect(tools.map((t) => t.name)).toEqual(["fake__probe"]);
    expect(grants).toEqual([{ tool: "fake__probe", patterns: ["*"] }]);
    expect(providerIdByTool.get("fake__probe")).toBe("fake");
  });

  test("skips a provider not attached to this stage", async () => {
    const { tools, grants } = await resolveProviderTools([provider()], "review", "/w/a");
    expect(tools).toEqual([]);
    expect(grants).toEqual([]);
  });

  test("records a stage-mismatched provider in skipped with its configured stages", async () => {
    const { skipped, tools } = await resolveProviderTools([provider({ id: "runonly" })], "review", "/w/a");
    expect(skipped).toEqual([{ providerId: "runonly", reason: "stage-mismatch", stages: ["run"] }]);
    expect(tools).toEqual([]);
  });

  test("records a tool rejected by admits in withheld, not advertised", async () => {
    const two = provider({
      tools: async () => [
        { localName: "kept", description: "k", inputSchema: { type: "object", properties: {} }, run: async () => ({ content: "k" }) },
        { localName: "dropped", description: "d", inputSchema: { type: "object", properties: {} }, run: async () => ({ content: "d" }) },
      ],
    });
    const { withheld, tools } = await resolveProviderTools([two], "run", "/w/a", {
      admits: (_providerId, localName) => localName !== "dropped",
    });
    expect(withheld).toEqual([{ providerId: "fake", localName: "dropped", reason: "not-admitted" }]);
    expect(tools.map((t) => t.name)).toEqual(["fake__kept"]);
  });

  test("no providers yields empty skipped and withheld", async () => {
    expect(await resolveProviderTools([], "run", "/w/a")).toMatchObject({ skipped: [], withheld: [] });
  });

  test("passes the hop root, not a shared one, to each provider", async () => {
    // The two-worktree case: the bug this guards is invisible with one root.
    const a = await resolveProviderTools([provider()], "run", "/w/a");
    const b = await resolveProviderTools([provider()], "run", "/w/b");
    expect(await a.tools[0].run({}, ctx("/w/a"))).toEqual({ content: "/w/a" });
    expect(await b.tools[0].run({}, ctx("/w/b"))).toEqual({ content: "/w/b" });
  });

  test("no providers yields no tools and no grants", async () => {
    expect(await resolveProviderTools([], "run", "/w/a")).toMatchObject({ tools: [], grants: [] });
  });

  test("a provider that throws is dropped, not fatal", async () => {
    const bad = provider({
      id: "bad",
      tools: async () => {
        throw new Error("boom");
      },
    });
    const { tools } = await resolveProviderTools([bad, provider()], "run", "/w/a");
    expect(tools.map((t) => t.name)).toEqual(["fake__probe"]);
  });
});

function ctx(root: string) {
  return { root, resolvedPaths: [], maxBytes: 100, maxFileBytes: 100 };
}
