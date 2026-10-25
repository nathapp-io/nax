import { beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createMemoryTranscriptStore,
  type LoopHandlerSet,
  type SessionBackend,
  type SessionEvent,
  type ToolProvider,
} from "@nathapp/nax-agent";
import { makeNaxConfig } from "@test/helpers";
import type { ChatMode } from "@/chat/chat-mode";
import { type _subagentSessionDeps, type RunSubagentInput, runSubagent } from "@/chat/subagent-session";
import type { ResolvedRule } from "@/context/rules/rule-set";
import { NaxError } from "@/errors";
import type { AgentResource } from "@/resources";

const AGENT_PROMPT = "Review the diff carefully.";
const agent: AgentResource = {
  kind: "agent",
  name: "reviewer",
  qualifiedName: "reviewer",
  description: "Reviews",
  prompt: AGENT_PROMPT,
  path: "/repo/.claude/agents/reviewer.md",
  origin: { kind: "claude-project" },
};
const backend: SessionBackend = {
  kind: "native",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};
const store = createMemoryTranscriptStore();

function turnEnd(output: string): SessionEvent {
  return {
    sessionId: "s",
    turnId: "t",
    at: "2026-10-01T00:00:00.000Z",
    metadata: {},
    type: "turn_end",
    status: "completed",
    output,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
  };
}

function provider(id: string): ToolProvider {
  return { id, kind: "static", stages: ["chat"], tools: async () => [] };
}

function rule(ruleId: string): ResolvedRule {
  return {
    fileName: `${ruleId}.md`,
    content: "# Logging\n",
    source: "repo",
    displayPath: `.nax/rules/${ruleId}.md`,
    ruleId,
  };
}

let stub: AgentSession;
let closed: Mock<() => Promise<void>>;
let sessionCalls: CreateAgentSessionOptions[];
let backendCalls: BackendOptions[];
let deps: typeof _subagentSessionDeps;
let input: RunSubagentInput;
const loopHandlers: LoopHandlerSet = [];
type BackendOptions = Parameters<(typeof _subagentSessionDeps)["nativeBackend"]>[0];

function sessionOptions(): CreateAgentSessionOptions {
  const [options] = sessionCalls;
  if (options === undefined) throw new Error("createAgentSession was not called");
  return options;
}
function backendOptions(): BackendOptions {
  const [options] = backendCalls;
  if (options === undefined) throw new Error("nativeBackend was not called");
  return options;
}

beforeEach(() => {
  closed = mock(async () => {});
  sessionCalls = [];
  backendCalls = [];
  stub = {
    id: "sub-1",
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {
      yield turnEnd("done");
    },
    answer: () => "unknown",
    cancel() {},
    close: closed,
  };
  deps = {
    createAgentSession: mock(async (options: CreateAgentSessionOptions) => {
      sessionCalls.push(options);
      return stub;
    }),
    nativeBackend: mock((options: BackendOptions) => {
      backendCalls.push(options);
      return backend;
    }),
    createMemoryTranscriptStore: mock(() => store),
    resolveRuleSet: mock(async () => ({
      rules: [],
      repoRulesTotal: 0,
      repoRulesMatchedPaths: 0,
      packageRulesCount: 0,
    })),
  };
  input = {
    agent,
    task: "check it",
    mode: "guarded",
    model: "anthropic/sonnet",
    toolProviders: [],
    loopHandlers,
    cwd: "/repo",
    repoRoot: "/repo",
    config: makeNaxConfig(),
    parentSessionId: "chat-1",
    onEvent: () => {},
  };
});

const run = (overrides: Partial<RunSubagentInput> = {}) => runSubagent({ ...input, ...overrides }, deps);

describe("runSubagent session options", () => {
  test.each<[string, ChatMode, CreateAgentSessionOptions["profile"]]>([
    ["AC-1", "guarded", "ask"],
    ["AC-2", "full", "full"],
  ])("%s mode %s opens profile %s", async (_ac, mode, profile) => {
    await run({ mode });
    expect(sessionOptions().profile).toBe(profile);
  });

  test.each<[string, ChatMode, BackendOptions["bashApproval"]]>([
    ["AC-3", "guarded", "gated"],
    ["AC-4", "full", "raw"],
  ])("%s mode %s uses bashApproval %s", async (_ac, mode, bashApproval) => {
    await run({ mode });
    expect(backendOptions().bashApproval).toBe(bashApproval);
  });

  test("AC-5 allows unsandboxed fallback and commands", async () => {
    await run();
    expect(backendOptions().allowUnsandboxed).toBe(true);
    expect(backendOptions().allowUnsandboxedCommands).toBe(true);
  });

  test("AC-6 uses the subagent loop handler role", async () => {
    await run();
    expect(backendOptions().loopHandlerRole).toBe("subagent");
  });

  test("AC-7 forwards the input's loopHandlers by identity", async () => {
    await run();
    expect(backendOptions().loopHandlers).toBe(loopHandlers);
  });

  test("carries history across models", async () => {
    await run();
    expect(backendOptions().carryHistoryAcrossModels).toBe(true);
  });

  test("AC-8 forwards the model", async () => {
    await run({ model: "a/s" });
    expect(backendOptions().model).toBe("a/s");
  });

  test("AC-9 forwards allowedTools", async () => {
    await run({ allowedTools: ["Read"] });
    expect(backendOptions().allowedTools).toEqual(["Read"]);
  });

  test("AC-10 omits the allowedTools key when none is given", async () => {
    await run();
    expect("allowedTools" in backendOptions()).toBe(false);
  });

  test("keeps an explicit empty allowedTools restriction", async () => {
    await run({ allowedTools: [] });
    expect(backendOptions().allowedTools).toEqual([]);
  });

  test("AC-11 forwards toolProviders", async () => {
    const skills = provider("nax-skills");
    const docs = provider("nax-docs");
    await run({ toolProviders: [skills, docs] });
    expect(backendOptions().toolProviders).toEqual([skills, docs]);
  });

  test("AC-12 forwards catalogOverrides", async () => {
    const catalogOverrides = [{ provider: "anthropic", models: [] }];
    await run({ config: makeNaxConfig({ agent: { native: { catalogOverrides } } }) });
    expect(backendOptions().catalogOverrides).toEqual(catalogOverrides);
  });

  test("omits empty catalogOverrides", async () => {
    await run({ config: makeNaxConfig({ agent: { native: { catalogOverrides: [] } } }) });
    expect("catalogOverrides" in backendOptions()).toBe(false);
  });

  test("AC-13 forwards compaction", async () => {
    const config = makeNaxConfig({ execution: { compaction: { enabled: false } } });
    await run({ config });
    expect(backendOptions().compaction).toEqual(config.execution.compaction);
    expect(backendOptions().compaction).toEqual(expect.objectContaining({ enabled: false }));
  });

  test("AC-14 uses the memory transcript store", async () => {
    await run();
    expect(deps.createMemoryTranscriptStore).toHaveBeenCalledTimes(1);
    expect(sessionOptions().transcriptStore).toBe(store);
  });

  test("AC-15 sets workdir from cwd", async () => {
    await run({ cwd: "/repo" });
    expect(sessionOptions().workdir).toBe("/repo");
  });

  test("AC-16 sets parent and subagent metadata", async () => {
    await run({ parentSessionId: "chat-1" });
    expect(sessionOptions().metadata).toEqual({ parentSessionId: "chat-1", subagent: "reviewer" });
  });

  test("AC-17 sets approvalTimeoutMs from config", async () => {
    await run({ config: makeNaxConfig({ execution: { approvalTimeout: 120000 } }) });
    expect(sessionOptions().approvalTimeoutMs).toBe(120000);
  });

  test("AC-18 instructions end with the agent prompt", async () => {
    await run();
    expect(sessionOptions().instructions?.endsWith(AGENT_PROMPT)).toBe(true);
  });

  test("AC-19 instructions contain the rule's index line", async () => {
    deps.resolveRuleSet = mock(async () => ({
      rules: [rule("logging-rule")],
      repoRulesTotal: 1,
      repoRulesMatchedPaths: 1,
      packageRulesCount: 0,
    }));
    await run();
    expect(sessionOptions().instructions).toContain("- `logging-rule` (.nax/rules/logging-rule.md): Logging.");
  });

  test("AC-20 resolves rules for the input's repoRoot", async () => {
    await run({ repoRoot: "/other-root" });
    expect(deps.resolveRuleSet).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/other-root", packageDir: "/other-root" }),
    );
  });

  test("passes the configured rule override fields", async () => {
    const config = makeNaxConfig({ context: { rules: { overrideDir: "/ovr", overrideMode: "replace" } } });
    await run({ config });
    expect(deps.resolveRuleSet).toHaveBeenCalledWith(
      expect.objectContaining({ overrideDir: "/ovr", overrideMode: "replace" }),
    );
  });
});

describe("runSubagent lifecycle", () => {
  test("sends the task, returns the turn output and closes the session", async () => {
    const send = mock(async function* (_message: string) {
      yield turnEnd("the answer");
    });
    stub = { ...stub, send };
    const events: SessionEvent[] = [];
    const seen: AgentSession[] = [];
    const result = await run({ onEvent: (e) => events.push(e), onSession: (s) => seen.push(s) });
    expect(result).toEqual({ content: "the answer" });
    expect(send).toHaveBeenCalledWith("check it");
    expect(events.map((e) => e.type)).toEqual(["turn_end"]);
    expect(seen).toEqual([stub]);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("does not reach createAgentSession when option construction fails", async () => {
    deps.nativeBackend = mock(() => {
      throw new NaxError("bad options", "TEST_FAILURE", { stage: "test" });
    });
    await expect(run()).rejects.toThrow("bad options");
    expect(sessionCalls).toEqual([]);
  });
});
