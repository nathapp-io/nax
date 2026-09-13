import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support";
import type { ToolProvider } from "@/tools";

function staticProvider(): ToolProvider {
  return {
    id: "acme",
    kind: "static",
    stages: ["run"],
    tools: async (workdir) => [
      {
        localName: "probe",
        description: workdir,
        inputSchema: { type: "object", properties: {} },
        run: async () => ({ content: workdir }),
      },
    ],
  };
}

function ctx(root: string) {
  return { root, resolvedPaths: [], maxBytes: 100, maxFileBytes: 100 };
}

function names(support: Awaited<ReturnType<typeof resolveCodingToolSupport>>): string[] {
  return support?.tools.map((t) => t.name) ?? [];
}

let rootA: string;
let rootB: string;

beforeEach(() => {
  rootA = makeTempDir("nax-providers-a-");
  rootB = makeTempDir("nax-providers-b-");
});

afterEach(() => {
  cleanupTempDir(rootA);
  cleanupTempDir(rootB);
});

describe("resolveCodingToolSupport — provider gate (R12)", () => {
  test("advertises a provider tool under unrestricted", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig(),
    });

    expect(names(support)).toContain("acme__probe");
  });

  test("does not advertise a provider tool under safe", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { permissionProfile: "safe" } }),
    });

    expect(names(support)).not.toContain("acme__probe");
  });

  test("does not advertise a provider tool under scoped", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig({
        execution: { permissionProfile: "scoped", permissions: { default: { allowedTools: ["Read"] } } },
      }),
    });

    expect(names(support)).toContain("Read");
    expect(names(support)).not.toContain("acme__probe");
  });
});

describe("resolveCodingToolSupport — provider-only op (R15)", () => {
  test("builds support when a provider supplies the only tool", async () => {
    const support = await resolveCodingToolSupport({
      declaredTools: [],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig(),
    });

    expect(support).toBeDefined();
    expect(names(support)).toContain("acme__probe");
  });
});

describe("resolveCodingToolSupport — hop root reaches the provider tool", () => {
  test("each hop runs the provider tool at its own root", async () => {
    const a = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootA,
      pipelineStage: "run",
      config: makeNaxConfig(),
    });
    const b = await resolveCodingToolSupport({
      declaredTools: ["Read"],
      providers: [staticProvider()],
      codingToolRoot: rootB,
      pipelineStage: "run",
      config: makeNaxConfig(),
    });

    const toolA = a?.tools.find((t) => t.name === "acme__probe");
    const toolB = b?.tools.find((t) => t.name === "acme__probe");
    if (toolA === undefined || toolB === undefined) throw new Error("provider tool was not advertised");

    expect(await toolA.run({}, ctx(rootA))).toEqual({ content: rootA });
    expect(await toolB.run({}, ctx(rootB))).toEqual({ content: rootB });
  });
});
