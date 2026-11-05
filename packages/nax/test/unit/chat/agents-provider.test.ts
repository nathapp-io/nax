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
  const run = mock(
    async (_agent: AgentResource, _task: string, _signal: AbortSignal | undefined, _model?: string) => okResult,
  );
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
  test("AC-6 inputSchema.required is [task]", async () => {
    const tool = (await setup([agent("reviewer")]).provider.tools("/w"))[0];
    expect(tool?.inputSchema.required).toEqual(["task"]);
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

describe("createAgentsProvider model override", () => {
  const BAD_MODEL = "[chat] run model must be a non-empty string";
  test("AC-1 schema has model: string and required is [task]", async () => {
    const tool = (await setup([agent("reviewer")]).provider.tools("/w"))[0];
    expect(Object.entries(tool?.inputSchema.properties ?? {}).find(([key]) => key === "model")?.[1]).toEqual({
      type: "string",
    });
    expect(tool?.inputSchema.required).toEqual(["task"]);
  });
  test("AC-2 description names the native example and acp:<agent>", async () => {
    const tool = (await setup([agent("reviewer")]).provider.tools("/w"))[0];
    expect(tool?.description).toContain("openai-codex/gpt-6-luna");
    expect(tool?.description).toContain("acp:<agent>");
  });
  test("AC-3 passes the AgentResource and model as the fourth argument", async () => {
    const reviewer = agent("reviewer");
    const { run, provider } = setup([reviewer]);
    const controller = new AbortController();
    await runTool(
      provider,
      { agent: "reviewer", task: "check it", model: "openai-codex/gpt-6-luna" },
      controller.signal,
    );
    expect(run.mock.calls[0]).toEqual([reviewer, "check it", controller.signal, "openai-codex/gpt-6-luna"]);
    expect(run.mock.calls[0]?.[0]).toBe(reviewer);
  });
  test("AC-4 without model calls run with exactly three arguments", async () => {
    const { run, provider } = setup([agent("reviewer")]);
    await runTool(provider, { agent: "reviewer", task: "t" });
    expect(run.mock.calls[0]).toHaveLength(3);
  });
  test.each([
    ["AC-5 a non-string model", 7],
    ["AC-6 a blank model", "  "],
  ])("%s is an error result and run is not called", async (_label, model) => {
    const { run, provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: "reviewer", task: "t", model })).toEqual({
      isError: true,
      content: BAD_MODEL,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

const RUN_DESCRIPTION =
  "Run a named catalog agent on a self-contained task and return its final answer. Optional model overrides the agent's model: provider/model (for example openai-codex/gpt-6-luna) runs it on the nax native agent with that provider's model; acp:<agent> (for example acp:codex) runs it on an installed ACP agent. A provider name such as openai-codex is a native provider, not the Codex ACP agent. To run a task on a model with no catalog agent, omit agent and pass model: the task runs on the built-in general agent with your tools.";
const NEEDS_AGENT_OR_MODEL = "[chat] run requires agent, or model to run the built-in general agent";

describe("createAgentsProvider bare-model dispatch (chat-dispatch-visibility US-002)", () => {
  test("AC-1 inputSchema.required is [task]", async () => {
    const tool = (await setup([agent("reviewer")]).provider.tools("/w"))[0];
    expect(tool?.inputSchema.required).toEqual(["task"]);
  });

  test("AC-2 the description is the frozen text naming the general-agent fallback", async () => {
    const tool = (await setup([agent("reviewer")]).provider.tools("/w"))[0];
    expect(tool?.description).toBe(RUN_DESCRIPTION);
  });

  test("AC-5 a model with no agent runs the built-in general agent on that model", async () => {
    const { run, provider } = setup([agent("reviewer")]);
    const controller = new AbortController();
    await runTool(provider, { task: "t", model: "openai-codex/gpt-6-luna" }, controller.signal);
    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0];
    assertDefined(call, "run call");
    const [calledAgent, calledTask, calledSignal, calledModel] = call;
    expect(calledAgent.name).toBe("general");
    expect(calledAgent.origin).toEqual({ kind: "nax-builtin" });
    expect(calledTask).toBe("t");
    expect(calledSignal).toBe(controller.signal);
    expect(calledModel).toBe("openai-codex/gpt-6-luna");
  });

  test("AC-6 a missing agent and a missing model names both requirements", async () => {
    const { provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { task: "t" })).toEqual({ isError: true, content: NEEDS_AGENT_OR_MODEL });
  });

  test("AC-7 a missing agent and a missing model does not call the injected run", async () => {
    const { run, provider } = setup([agent("reviewer")]);
    await runTool(provider, { task: "t" });
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-8 a blank model with no agent is an error result", async () => {
    const { provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { task: "t", model: "  " })).toEqual({
      isError: true,
      content: "[chat] run model must be a non-empty string",
    });
  });

  test("AC-9 a blank model with no agent does not call the injected run", async () => {
    const { run, provider } = setup([agent("reviewer")]);
    await runTool(provider, { task: "t", model: "  " });
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-10 a non-string agent is an error result even with a model", async () => {
    const { provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: 1, task: "t", model: "p/x" })).toEqual({
      isError: true,
      content: INVALID_INPUT,
    });
  });

  test("AC-11 a non-string agent does not call the injected run", async () => {
    const { run, provider } = setup([agent("reviewer")]);
    await runTool(provider, { agent: 1, task: "t", model: "p/x" });
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-12 a missing task with a model is an error result", async () => {
    const { provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { model: "p/x" })).toEqual({ isError: true, content: INVALID_INPUT });
  });

  test("AC-13 a missing task with a model does not call the injected run", async () => {
    const { run, provider } = setup([agent("reviewer")]);
    await runTool(provider, { model: "p/x" });
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-14 an unknown agent with a model lists the available names", async () => {
    const { provider } = setup([agent("reviewer")]);
    const result = await runTool(provider, { agent: "nobody", task: "t", model: "p/x" });
    expect(result.isError).toBe(true);
    expect(result.content.startsWith("unknown agent nobody; available:")).toBe(true);
  });

  test("AC-15 an unknown agent with a model does not call the injected run", async () => {
    const { run, provider } = setup([agent("reviewer")]);
    await runTool(provider, { agent: "nobody", task: "t", model: "p/x" });
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-18 a catalog with no agents still advertises no tools", async () => {
    expect(await setup([]).provider.tools("/w")).toEqual([]);
  });

  test("AC-19 a named agent with no model still calls run with exactly three arguments", async () => {
    const reviewer = agent("reviewer");
    const { run, provider } = setup([reviewer]);
    const controller = new AbortController();
    await runTool(provider, { agent: "reviewer", task: "t" }, controller.signal);
    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0];
    assertDefined(call, "run call");
    expect(call).toHaveLength(3);
    expect([...call]).toEqual([reviewer, "t", controller.signal]);
  });
});
