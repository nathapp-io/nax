/**
 * `runInBackground` on `nax-agents__run`: the input schema, the exact description
 * sentence, the validation order and the dispatch between the foreground and the
 * background callback.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ToolProvider, ToolResult, ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { createAgentsProvider } from "@/chat/agents-provider";
import { generalAgent } from "@/chat/builtin-agent";
import { type AgentResource, buildResourceCatalog, type ResourceOrigin, type ResourcePackage } from "@/resources";

const projectOrigin = { kind: "claude-project" } as const;
const EXPLORE_SENTENCE = "For read-only code search, pass agent explore: it has Read, Glob, Grep and Git only.";

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

const foregroundResult: ToolResult = { content: "done", audit: { executed: ["x"] } };
const backgroundResult: ToolResult = { content: "started in the background as agent-0123abcd" };

function setup(agents: AgentResource[], opts: { background?: boolean } = {}) {
  const run = mock(
    async (_agent: AgentResource, _task: string, _signal: AbortSignal | undefined, _model?: string) => foregroundResult,
  );
  const runInBackground = mock(async (_agent: AgentResource, _task: string, _model?: string) => backgroundResult);
  const provider = createAgentsProvider({
    catalog: catalogOf(...agents),
    run,
    ...(opts.background === false ? {} : { runInBackground }),
  });
  return { run, runInBackground, provider };
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

describe("createAgentsProvider runInBackground schema and description", () => {
  test("AC-1 inputSchema offers runInBackground as a boolean and keeps required/additionalProperties", async () => {
    const tool = (await setup([agent("reviewer")]).provider.tools("/w"))[0];
    assertDefined(tool, "tool");
    expect(Object.entries(tool.inputSchema.properties ?? {}).find(([key]) => key === "runInBackground")?.[1]).toEqual({
      type: "boolean",
    });
    expect(tool.inputSchema.required).toEqual(["task"]);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  test("AC-2 the description states the background contract and still ends with the explore sentence", async () => {
    const tool = (await setup([agent("reviewer")]).provider.tools("/w"))[0];
    assertDefined(tool, "tool");
    expect(tool.description).toContain('Set "runInBackground": true to return at once with a task id');
    expect(tool.description.endsWith(EXPLORE_SENTENCE)).toBe(true);
  });
});

describe("createAgentsProvider runInBackground dispatch", () => {
  test("AC-3 runInBackground true calls only the background callback with exactly two arguments", async () => {
    const reviewer = agent("reviewer");
    const { run, runInBackground, provider } = setup([reviewer]);
    await runTool(provider, { agent: "reviewer", task: "check it", runInBackground: true });
    expect(runInBackground).toHaveBeenCalledTimes(1);
    const call = runInBackground.mock.calls[0];
    assertDefined(call, "runInBackground call");
    expect(call).toHaveLength(2);
    expect(call[0]).toBe(reviewer);
    expect(call[1]).toBe("check it");
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-4 runInBackground true with a bare task and a model runs the general agent on that model", async () => {
    const { run, runInBackground, provider } = setup([agent("reviewer")]);
    await runTool(provider, { task: "check it", runInBackground: true, model: "openai-codex/gpt-6-luna" });
    expect(runInBackground).toHaveBeenCalledTimes(1);
    const call = runInBackground.mock.calls[0];
    assertDefined(call, "runInBackground call");
    expect(call).toHaveLength(3);
    expect(call[0]).toEqual(generalAgent());
    expect(call[0]?.origin).toEqual({ kind: "nax-builtin" });
    expect(call[1]).toBe("check it");
    expect(call[2]).toBe("openai-codex/gpt-6-luna");
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-5 the background result is returned unchanged", async () => {
    const { provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: "reviewer", task: "check it", runInBackground: true })).toBe(
      backgroundResult,
    );
  });

  test("AC-6 runInBackground false calls only run with the agent, task and context signal", async () => {
    const reviewer = agent("reviewer");
    const { run, runInBackground, provider } = setup([reviewer]);
    const controller = new AbortController();
    await runTool(provider, { agent: "reviewer", task: "check it", runInBackground: false }, controller.signal);
    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0];
    assertDefined(call, "run call");
    expect(call).toHaveLength(3);
    expect(call[0]).toBe(reviewer);
    expect(call[1]).toBe("check it");
    expect(call[2]).toBe(controller.signal);
    expect(runInBackground).not.toHaveBeenCalled();
  });
});

describe("createAgentsProvider runInBackground validation", () => {
  test("AC-7 a non-boolean runInBackground is an error result and calls neither callback", async () => {
    const { run, runInBackground, provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: "reviewer", task: "check it", runInBackground: "yes" })).toEqual({
      isError: true,
      content: "[chat] run runInBackground must be a boolean",
    });
    expect(run).not.toHaveBeenCalled();
    expect(runInBackground).not.toHaveBeenCalled();
  });

  test("AC-8 runInBackground true without the callback is an error result", async () => {
    const { run, provider } = setup([agent("reviewer")], { background: false });
    expect(await runTool(provider, { agent: "reviewer", task: "check it", runInBackground: true })).toEqual({
      isError: true,
      content: "[chat] runInBackground is not available in this chat",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("AC-9 an unknown agent is still today's error result and calls neither callback", async () => {
    const { run, runInBackground, provider } = setup([agent("reviewer")]);
    expect(await runTool(provider, { agent: "nope", task: "check it", runInBackground: true })).toEqual({
      isError: true,
      content: "unknown agent nope; available: reviewer",
    });
    expect(run).not.toHaveBeenCalled();
    expect(runInBackground).not.toHaveBeenCalled();
  });

  test("AC-9 an unknown agent outranks the missing background capability", async () => {
    const { provider } = setup([agent("reviewer")], { background: false });
    expect(await runTool(provider, { agent: "nope", task: "check it", runInBackground: true })).toEqual({
      isError: true,
      content: "unknown agent nope; available: reviewer",
    });
  });
});
