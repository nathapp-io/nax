/**
 * US-007: the run input `nax agents run` composes for one headless subagent task.
 *
 * Every test enters through `buildAgentsRunTaskInput` with `_agentsRunComposeDeps` stubbed, so
 * what is asserted is the model request, the tool set, the two ordered providers and the rule
 * handlers the command hands over — no catalog is loaded and no provider is created for real.
 */
import { describe, expect, test } from "bun:test";
import type { LoopHandlerSet, ToolProvider } from "@nathapp/nax-agent";
import { makeAgentCatalog, makeAgentResource, makeNaxConfig, withDepsRestore } from "@test/helpers";
import { mapSubagentTools } from "@/chat";
import {
  _agentsRunComposeDeps,
  AGENTS_RUN_NATIVE_READ_TOOLS,
  type AgentsRunComposeInput,
  buildAgentsRunTaskInput,
} from "@/cli/agents-run-compose";
import { getProjectKey, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import type { ResourceCatalog } from "@/resources";
import { projectOutputDir } from "@/runtime";

type ModelRequest = Parameters<typeof _agentsRunComposeDeps.resolveAgentsRunModel>[0];
type WorkflowRequest = Parameters<typeof _agentsRunComposeDeps.createWorkflowProvider>[0];
type RulesRequest = Parameters<typeof _agentsRunComposeDeps.createRuleDeliveryHandlers>[0];

const REPO_ROOT = "/repo";
const CWD = "/repo/packages/nax";
const NATIVE_MODEL = "openai/gpt-bal";
const ACP_MODEL = "acp:codex/x";
const READ_TOOLS = ["Read", "Glob", "Grep", "Git", "nax-skills__*", "nax-workflow__*"];

const skillsProvider: ToolProvider = { id: "nax-skills", kind: "static", stages: ["*"], tools: async () => [] };
const workflowProvider: ToolProvider = { id: "nax-workflow", kind: "static", stages: ["*"], tools: async () => [] };
const ruleHandlers: LoopHandlerSet = Object.freeze([
  { plugin: "nax-rules", event: "before_tool", handler: () => ({ kind: "allow" as const }) },
]);

const catalog: ResourceCatalog = makeAgentCatalog([makeAgentResource({ name: "spec-reviewer" })]);

/** What the stubbed factories were handed, in call order. */
interface StubCalls {
  readonly models: ModelRequest[];
  readonly skillsLoaders: Array<() => Promise<ResourceCatalog>>;
  readonly workflow: WorkflowRequest[];
  readonly rules: RulesRequest[];
}

/** Replace every seam `buildAgentsRunTaskInput` reaches, recording each call and each argument. */
function stubDeps(model: string = NATIVE_MODEL): StubCalls {
  const calls: StubCalls = { models: [], skillsLoaders: [], workflow: [], rules: [] };
  _agentsRunComposeDeps.resolveAgentsRunModel = (request) => {
    calls.models.push(request);
    return model;
  };
  _agentsRunComposeDeps.createSkillsProvider = (load) => {
    calls.skillsLoaders.push(load);
    return skillsProvider;
  };
  _agentsRunComposeDeps.createWorkflowProvider = (options) => {
    calls.workflow.push(options);
    return workflowProvider;
  };
  _agentsRunComposeDeps.createRuleDeliveryHandlers = (options) => {
    calls.rules.push(options);
    return ruleHandlers;
  };
  return calls;
}

function input(overrides: Partial<AgentsRunComposeInput> = {}): AgentsRunComposeInput {
  return {
    agent: makeAgentResource({ name: "spec-reviewer" }),
    task: "review the spec at .nax/features/agents-run/spec.md",
    catalog,
    config: makeNaxConfig(),
    cwd: CWD,
    repoRoot: REPO_ROOT,
    ...overrides,
  };
}

/** The first element, or a failure naming what was never called. */
function first<T>(values: readonly T[], what: string): T {
  const [value] = values;
  if (value === undefined) throw new Error(`expected ${what} to be called once; it was never called`);
  return value;
}

function pipelineConfig(maxIterations: number): NaxConfig {
  return makeNaxConfig({ execution: { mode: "pipeline", maxIterations } });
}

describe("buildAgentsRunTaskInput", () => {
  withDepsRestore(_agentsRunComposeDeps);

  describe("the constant", () => {
    test("AC-1: AGENTS_RUN_NATIVE_READ_TOOLS is the read-only set a native agent gets by default", () => {
      expect(AGENTS_RUN_NATIVE_READ_TOOLS).toEqual(READ_TOOLS);
    });
  });

  describe("the model", () => {
    test("AC-2: forwards agent, config and --model to resolveAgentsRunModel and returns its model", () => {
      const calls = stubDeps(NATIVE_MODEL);
      const request = input({ modelOverride: "acp:codex/x" });
      const result = buildAgentsRunTaskInput(request);
      expect(calls.models).toHaveLength(1);
      expect(first(calls.models, "resolveAgentsRunModel")).toEqual({
        agent: request.agent,
        config: request.config,
        modelOverride: "acp:codex/x",
      });
      expect(result.model).toBe(NATIVE_MODEL);
    });

    test("AC-3: propagates the NaxError resolveAgentsRunModel throws unchanged", () => {
      stubDeps();
      const failure = new NaxError("unknown model nonsense; pass provider/model", "AGENTS_RUN_USAGE", {
        stage: "agents-run",
      });
      _agentsRunComposeDeps.resolveAgentsRunModel = () => {
        throw failure;
      };
      let caught: unknown;
      try {
        buildAgentsRunTaskInput(input());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(failure);
    });
  });

  describe("the tools", () => {
    test("AC-4: a native model with no tools: line narrows to the native read tools", () => {
      stubDeps(NATIVE_MODEL);
      const result = buildAgentsRunTaskInput(input({ agent: makeAgentResource({ tools: undefined }) }));
      expect(result.allowedTools).toEqual(AGENTS_RUN_NATIVE_READ_TOOLS);
      expect(result.allowedTools).toEqual(READ_TOOLS);
    });

    test("AC-5: an acp: model with no tools: line has no allowedTools field", () => {
      stubDeps(ACP_MODEL);
      const result = buildAgentsRunTaskInput(input({ agent: makeAgentResource({ tools: undefined }) }));
      expect("allowedTools" in result).toBe(false);
    });

    test("AC-6: a declared tools: line is mapped through mapSubagentTools", () => {
      stubDeps(NATIVE_MODEL);
      const result = buildAgentsRunTaskInput(input({ agent: makeAgentResource({ tools: ["Read", "Skill"] }) }));
      expect(result.allowedTools).toEqual(mapSubagentTools(["Read", "Skill"]).allowedTools);
      expect(result.allowedTools).toEqual(["Read", "nax-skills__*"]);
    });
  });

  describe("the providers", () => {
    test("AC-7: skills then workflow, in that order", () => {
      stubDeps();
      const result = buildAgentsRunTaskInput(input());
      expect(result.toolProviders).toHaveLength(2);
      expect(result.toolProviders[0]).toBe(skillsProvider);
      expect(result.toolProviders[1]).toBe(workflowProvider);
    });

    test("AC-8: the skills loader resolves to the input catalog", async () => {
      const calls = stubDeps();
      buildAgentsRunTaskInput(input());
      const load = first(calls.skillsLoaders, "createSkillsProvider");
      expect(await load()).toBe(catalog);
    });

    test("AC-9: pipeline mode passes the project output dir and execution.maxIterations", () => {
      const calls = stubDeps();
      const config = pipelineConfig(7);
      buildAgentsRunTaskInput(input({ config }));
      expect(first(calls.workflow, "createWorkflowProvider")).toEqual({
        repoRoot: REPO_ROOT,
        outputDir: projectOutputDir(getProjectKey(config, REPO_ROOT), config.outputDir),
        maxIterations: 7,
      });
    });

    test("AC-10: workflow mode leaves maxIterations undefined", () => {
      const calls = stubDeps();
      buildAgentsRunTaskInput(input({ config: makeNaxConfig({ execution: { mode: "workflow" } }) }));
      expect(first(calls.workflow, "createWorkflowProvider").maxIterations).toBeUndefined();
    });
  });

  describe("the rule handlers", () => {
    test("AC-11: forwards repoRoot and the configured override dir and mode", () => {
      const calls = stubDeps();
      const config = makeNaxConfig({ context: { rules: { overrideDir: "/override/rules", overrideMode: "replace" } } });
      buildAgentsRunTaskInput(input({ config }));
      expect(first(calls.rules, "createRuleDeliveryHandlers")).toEqual({
        repoRoot: REPO_ROOT,
        overrideDir: config.context.rules.overrideDir,
        overrideMode: config.context.rules.overrideMode,
      });
    });

    test("AC-12: returns the handler set the factory returned", () => {
      stubDeps();
      expect(buildAgentsRunTaskInput(input()).loopHandlers).toBe(ruleHandlers);
    });
  });

  describe("the rest of the input", () => {
    test("AC-13: forwards agent, task, cwd, repoRoot, config, timeoutSeconds and signal", () => {
      stubDeps();
      const controller = new AbortController();
      const request = input({ timeoutSeconds: 90, signal: controller.signal });
      const result = buildAgentsRunTaskInput(request);
      expect({
        agent: result.agent,
        task: result.task,
        cwd: result.cwd,
        repoRoot: result.repoRoot,
        config: result.config,
        timeoutSeconds: result.timeoutSeconds,
        signal: result.signal,
      }).toEqual({
        agent: request.agent,
        task: request.task,
        cwd: request.cwd,
        repoRoot: request.repoRoot,
        config: request.config,
        timeoutSeconds: 90,
        signal: controller.signal,
      });
    });
  });
});
