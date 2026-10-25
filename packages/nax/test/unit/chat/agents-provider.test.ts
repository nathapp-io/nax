import { describe, expect, mock, test } from "bun:test";
import type { ToolProvider, ToolResult, ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { createAgentsProvider } from "@/chat/agents-provider";
import {
  type AgentResource,
  buildResourceCatalog,
  parseAgentFile,
  type ResourceOrigin,
  type ResourcePackage,
} from "@/resources";

const projectOrigin = { kind: "claude-project" } as const;
const pluginOrigin = { kind: "claude-plugin", plugin: "p", marketplace: "m" } as const;
const INVALID_INPUT = "[chat] run requires agent: string and task: string";

function agent(name: string, origin: ResourceOrigin = projectOrigin, description = "Reviews diffs"): AgentResource {
  return {
    kind: "agent",
    name,
    qualifiedName: "plugin" in origin ? `${origin.plugin}:${name}` : name,
    description,
    prompt: `Prompt of ${name}`,
    path: `/fixture/agents/${name}.md`,
    origin,
  };
}

function pkg(id: string, origin: ResourceOrigin, agents: readonly AgentResource[]): ResourcePackage {
  return {
    id,
    origin,
    root: `/fixture/${id}`,
    skills: [],
    commands: [],
    agents,
    mcpServers: [],
    hooks: [],
    diagnostics: [],
  };
}

function catalogOf(...agents: AgentResource[]) {
  return buildResourceCatalog(agents.length ? [pkg("claude-project", projectOrigin, agents)] : []);
}

const okResult: ToolResult = { content: "done", audit: { executed: ["x"] } };

function setup(agents: AgentResource[]) {
  const run = mock(async (_agent: AgentResource, _task: string, _signal: AbortSignal | undefined) => okResult);
  const provider = createAgentsProvider({ catalog: catalogOf(...agents), run });
  return { run, provider };
}

function ctxOf(signal?: AbortSignal): ToolRunContext {
  return {
    root: "/w",
    resolvedPaths: [],
    maxBytes: 300_000,
    maxFileBytes: 300_000,
    ...(signal ? { signal } : {}),
  };
}

async function runTool(provider: ToolProvider, input: Record<string, unknown>, signal?: AbortSignal) {
  const tool = (await provider.tools("/w"))[0];
  assertDefined(tool, "tool");
  return tool.run(input, ctxOf(signal));
}

describe("createAgentsProvider identity", () => {
  const { provider } = setup([]);
  test("AC-1 id is nax-agents", () => {
    expect(provider.id).toBe("nax-agents");
  });
  test("AC-2 kind is static", () => {
    expect(provider.kind).toBe("static");
  });
  test("AC-3 stages is [*]", () => {
    expect(provider.stages).toEqual(["*"]);
  });
});

describe("createAgentsProvider tools and instructions", () => {
  test("AC-4 no agents yields no tools", async () => {
    expect(await setup([]).provider.tools("/w")).toEqual([]);
  });
  test("AC-5 one agent yields one tool named run", async () => {
    const tools = await setup([agent("reviewer")]).provider.tools("/w");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.localName).toBe("run");
  });
  test("AC-6 inputSchema.required is [agent, task]", async () => {
    const tool = (await setup([agent("reviewer")]).provider.tools("/w"))[0];
    expect(tool?.inputSchema.required).toEqual(["agent", "task"]);
  });
  test("AC-7 inputSchema.additionalProperties is false", async () => {
    const tool = (await setup([agent("reviewer")]).provider.tools("/w"))[0];
    expect(tool?.inputSchema.additionalProperties).toBe(false);
  });
  test("AC-8 instructions list the agent line", async () => {
    const text = await setup([agent("reviewer")]).provider.instructions?.("/w");
    expect(text).toContain("- reviewer: Reviews diffs");
  });
  test("AC-9 instructions are undefined with no agents", async () => {
    expect(await setup([]).provider.instructions?.("/w")).toBeUndefined();
  });
});

describe("createAgentsProvider run", () => {
  test("AC-10 calls the injected run once with the agent, task and context signal", async () => {
    const reviewer = agent("reviewer");
    const { run, provider } = setup([reviewer]);
    const controller = new AbortController();
    await runTool(provider, { agent: "reviewer", task: "check it" }, controller.signal);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual([reviewer, "check it", controller.signal]);
    expect(run.mock.calls[0]?.[2]).toBe(controller.signal);
  });
  test("AC-11 returns the injected result unchanged", async () => {
    const { provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: "reviewer", task: "t" })).toBe(okResult);
  });
  test("AC-12 a missing task is an error result", async () => {
    const { provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: "reviewer" })).toEqual({ isError: true, content: INVALID_INPUT });
  });
  test("AC-14 a non-string agent is an error result", async () => {
    const { provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: 1, task: "t" })).toEqual({ isError: true, content: INVALID_INPUT });
  });
  test("AC-15 a trim-empty task is an error result", async () => {
    const { provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: "reviewer", task: "  " })).toEqual({
      isError: true,
      content: INVALID_INPUT,
    });
  });
  test.each([
    ["missing task", { agent: "reviewer" }],
    ["missing agent", { task: "t" }],
    ["non-string agent", { agent: 1, task: "t" }],
    ["non-string task", { agent: "reviewer", task: 2 }],
    ["trim-empty agent", { agent: " \n", task: "t" }],
    ["trim-empty task", { agent: "reviewer", task: "\t " }],
  ])("AC-13 %s does not call the injected run", async (_label, input) => {
    const { run, provider } = setup([agent("reviewer")]);
    const result = await runTool(provider, input);
    expect(result).toEqual({ isError: true, content: INVALID_INPUT });
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-16 an unknown agent lists the available names", async () => {
    const { run, provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: "nobody", task: "t" })).toEqual({
      isError: true,
      content: "unknown agent nobody; available: reviewer",
    });
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-17 an unknown agent over 25 agents lists exactly 20 qualified names in catalog order", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `agent${String(i).padStart(2, "0")}`);
    const { provider } = setup(names.map((name) => agent(name)));
    const result = await runTool(provider, { agent: "nobody", task: "t" });
    const prefix = "unknown agent nobody; available: ";
    expect(result.content.startsWith(prefix)).toBe(true);
    expect(result.content.slice(prefix.length).split(", ")).toEqual(names.slice(0, 20));
  });
  test("AC-18 a qualified name reaches the shadowed plugin agent", async () => {
    const projectAgent = agent("reviewer");
    const pluginAgent = agent("reviewer", pluginOrigin);
    const run = mock(async (_agent: AgentResource, _task: string, _signal: AbortSignal | undefined) => okResult);
    const catalog = buildResourceCatalog([
      pkg("claude-project", projectOrigin, [projectAgent]),
      pkg("p@m", pluginOrigin, [pluginAgent]),
    ]);
    const provider = createAgentsProvider({ catalog, run });
    await runTool(provider, { agent: "p:reviewer", task: "t" });
    expect(run.mock.calls[0]?.[0]).toBe(pluginAgent);
    await runTool(provider, { agent: "reviewer", task: "t" });
    expect(run.mock.calls[1]?.[0]).toBe(projectAgent);
  });
  test("passes undefined when the context carries no signal", async () => {
    const { run, provider } = setup([agent("reviewer")]);
    await runTool(provider, { agent: "reviewer", task: "t" });
    expect(run.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe("createAgentsProvider over a parsed catalog", () => {
  test("AC-19 the runner receives the parsed agent prompt", async () => {
    const parsed = parseAgentFile(
      "/fixture/agents/reviewer.md",
      "---\nname: reviewer\ndescription: Reviews tests\n---\nCheck tests.",
      projectOrigin,
    );
    if (!("resource" in parsed)) throw new Error("agent fixture did not parse");
    const catalog = buildResourceCatalog([pkg("claude-project", projectOrigin, [parsed.resource])]);
    const run = mock(async (_agent: AgentResource, _task: string, _signal: AbortSignal | undefined) => okResult);
    const provider = createAgentsProvider({ catalog, run });
    await runTool(provider, { agent: "reviewer", task: "go" });
    expect(run.mock.calls[0]?.[0].prompt).toBe("Check tests.");
    expect(await provider.instructions?.("/w")).toContain("- reviewer: Reviews tests");
  });
});
