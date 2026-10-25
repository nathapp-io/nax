import { describe, expect, test } from "bun:test";
import { resolveProviderTools } from "#src/tools/provider-advertise";
import type { ProviderTool, ToolProvider } from "#src/tools/provider-types";
import { withWarnSpy } from "#test/helpers/index";

function probeTool(description: string): ProviderTool {
  return {
    localName: "probe",
    description,
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ content: description }),
  };
}

function provider(over: Partial<ToolProvider> = {}): ToolProvider {
  const seen: string[] = [];
  return {
    id: "fake",
    kind: "static",
    stages: ["run"],
    tools: async (workdir: string) => {
      seen.push(workdir);
      return [probeTool(workdir)];
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
        {
          localName: "kept",
          description: "k",
          inputSchema: { type: "object", properties: {} },
          run: async () => ({ content: "k" }),
        },
        {
          localName: "dropped",
          description: "d",
          inputSchema: { type: "object", properties: {} },
          run: async () => ({ content: "d" }),
        },
      ],
    });
    const { withheld, tools } = await resolveProviderTools([two], "run", "/w/a", {
      admits: (_providerId, localName) => localName !== "dropped",
    });
    expect(withheld).toEqual([{ providerId: "fake", localName: "dropped", reason: "not-admitted" }]);
    expect(tools.map((t) => t.name)).toEqual(["fake__kept"]);
  });

  describe("askTools", () => {
    const acme = (kind: ToolProvider["kind"], tools: readonly ProviderTool[]): ToolProvider =>
      provider({ id: "acme", kind, stages: ["*"], tools: async () => tools });
    const named = (localName: string, over: Partial<ProviderTool> = {}): ProviderTool => ({
      ...probeTool(localName),
      localName,
      ...over,
    });

    test("AC-6: lists the namespaced discovered tools that are not readOnly, in advertise order", async () => {
      const result = await resolveProviderTools(
        [acme("discovered", [named("get", { readOnly: true }), named("put"), named("post", { readOnly: false })])],
        "session",
        "/w",
      );
      expect(result.askTools).toEqual(["acme__put", "acme__post"]);
    });

    test("AC-7: has no askTools key when every discovered tool is readOnly", async () => {
      const result = await resolveProviderTools(
        [acme("discovered", [named("get", { readOnly: true })])],
        "session",
        "/w",
      );
      expect(result.tools.map((t) => t.name)).toEqual(["acme__get"]);
      expect("askTools" in result).toBe(false);
    });

    test("AC-8: has no askTools key for a static provider whose tool has no readOnly", async () => {
      const result = await resolveProviderTools([acme("static", [named("load")])], "session", "/w");
      expect(result.tools.map((t) => t.name)).toEqual(["acme__load"]);
      expect("askTools" in result).toBe(false);
    });

    test("a tool withheld by admits is not an ask tool", async () => {
      const result = await resolveProviderTools([acme("discovered", [named("put")])], "session", "/w", {
        admits: () => false,
      });
      expect("askTools" in result).toBe(false);
    });
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

  test("returns an attached provider's instructions beside its tools", async () => {
    const cm = provider({ id: "cm", instructions: async () => "use repo root" });
    const { instructions } = await resolveProviderTools([cm], "run", "/w");
    expect(instructions).toEqual([{ providerId: "cm", text: "use repo root" }]);
  });

  test("asks for instructions with the same hop root it passed to tools", async () => {
    const asked: string[] = [];
    const hop = provider({
      tools: async (workdir: string) => {
        asked.push(`tools ${workdir}`);
        return [probeTool(workdir)];
      },
      instructions: async (workdir: string) => {
        asked.push(`instructions ${workdir}`);
        return "use repo root";
      },
    });
    await resolveProviderTools([hop], "run", "/w/hop");
    expect(asked).toEqual(["tools /w/hop", "instructions /w/hop"]);
  });

  test("never asks a provider whose stages exclude this hop", async () => {
    const asked: string[] = [];
    const runOnly = provider({
      id: "runonly",
      stages: ["run"],
      instructions: async () => {
        asked.push("asked");
        return "use repo root";
      },
    });
    const review = provider({ id: "review", stages: ["review"], instructions: async () => "review only" });
    const { instructions } = await resolveProviderTools([runOnly, review], "review", "/w");
    expect(asked).toEqual([]);
    expect(instructions).toEqual([{ providerId: "review", text: "review only" }]);
  });

  test("no instructions for a provider left with no admitted tools", async () => {
    const asked: string[] = [];
    const gated = provider({
      id: "gated",
      instructions: async () => {
        asked.push("asked");
        return "use repo root";
      },
    });
    const kept = provider({ id: "kept", instructions: async () => "kept instructions" });
    const { tools, ...rest } = await resolveProviderTools([gated, kept], "run", "/w", {
      admits: (providerId) => providerId !== "gated",
    });
    expect(tools.map((t) => t.name)).toEqual(["kept__probe"]);
    expect(asked).toEqual([]);
    expect(rest.instructions).toEqual([{ providerId: "kept", text: "kept instructions" }]);
  });

  test("an empty instructions string contributes nothing", async () => {
    const blank = provider({ id: "blank", instructions: async () => "" });
    const speaking = provider({ id: "speaking", instructions: async () => "use repo root" });
    const { tools, ...rest } = await resolveProviderTools([blank, speaking], "run", "/w");
    expect(tools.map((t) => t.name)).toEqual(["blank__probe", "speaking__probe"]);
    expect(rest.instructions).toEqual([{ providerId: "speaking", text: "use repo root" }]);
  });

  test("a provider whose instructions throw keeps its tools and costs one warn", async () => {
    const broken = provider({
      id: "broken",
      instructions: async () => {
        throw new Error("boom");
      },
    });
    await withWarnSpy(async (warnSpy) => {
      const { tools, ...rest } = await resolveProviderTools([broken], "run", "/w");
      expect(tools.map((t) => t.name)).toEqual(["broken__probe"]);
      expect("instructions" in rest).toBe(false);
      expect(warnSpy.mock.calls.filter((c) => c[1].includes("broken"))).toHaveLength(1);
    });
  });
});

function ctx(root: string) {
  return { root, resolvedPaths: [], maxBytes: 100, maxFileBytes: 100 };
}
