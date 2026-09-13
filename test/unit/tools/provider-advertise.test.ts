import { describe, expect, test } from "bun:test";
import { resolveProviderTools } from "@/tools/provider-advertise";
import type { ProviderTool, ToolProvider } from "@/tools/provider-types";

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
    const { tools, grants } = await resolveProviderTools([provider()], "run", "/w/a");
    expect(tools.map((t) => t.name)).toEqual(["fake__probe"]);
    expect(grants).toEqual([{ tool: "fake__probe", patterns: ["*"] }]);
  });

  test("skips a provider not attached to this stage", async () => {
    const { tools, grants } = await resolveProviderTools([provider()], "review", "/w/a");
    expect(tools).toEqual([]);
    expect(grants).toEqual([]);
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
