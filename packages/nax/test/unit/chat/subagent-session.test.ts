import { beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createMemoryTranscriptStore,
  type LoopHandlerSet,
  type SessionBackend,
  type SessionEvent,
  type ToolProvider,
  type TurnEndStatus,
} from "@nathapp/nax-agent";
import { makeNaxConfig } from "@test/helpers";
import type { ChatMode } from "@/chat/chat-mode";
import { type _subagentSessionDeps, type RunSubagentInput, runSubagent } from "@/chat/subagent-session";
import type { TuiPermissions } from "@/config";
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

function turnEnd(output: string, status: TurnEndStatus = "completed", error?: { code: string; message: string }) {
  const event: SessionEvent = {
    sessionId: "s",
    turnId: "t",
    at: "2026-10-01T00:00:00.000Z",
    metadata: {},
    type: "turn_end",
    status,
    output,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    ...(error !== undefined ? { error } : {}),
  };
  return event;
}

function textDelta(text: string): SessionEvent {
  return {
    sessionId: "s",
    turnId: "t",
    at: "2026-10-01T00:00:00.000Z",
    metadata: {},
    type: "text_delta",
    round: 1,
    text,
  };
}

/** A session whose turn ends with `event`. */
function sessionEnding(event: SessionEvent): AgentSession {
  return {
    ...stub,
    async *send() {
      yield event;
    },
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
    resolveTuiPermissions: mock((): TuiPermissions => ({ bashApproval: "raw", askRules: [], denyRules: [] })),
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
    ["AC-1", "guarded", "full"],
    ["AC-2", "full", "full"],
  ])("%s mode %s opens profile %s", async (_ac, mode, profile) => {
    await run({ mode });
    expect(sessionOptions().profile).toBe(profile);
  });

  test.each<[string, ChatMode, BackendOptions["bashApproval"]]>([
    ["AC-3", "guarded", "raw"],
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
  test("AC-1 AC-2 AC-3 sends the task only, announces the session first, forwards events in order", async () => {
    const order: string[] = [];
    const send = mock(async function* (_message: string) {
      order.push("send");
      yield textDelta("a");
      yield turnEnd("the answer");
    });
    stub = { ...stub, send };
    const events: SessionEvent[] = [];
    const seen: AgentSession[] = [];
    const result = await run({
      onEvent: (e) => events.push(e),
      onSession: (s) => {
        order.push("onSession");
        seen.push(s);
      },
    });
    expect(result).toEqual({ content: "the answer" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("check it");
    expect(events.map((e) => e.type)).toEqual(["text_delta", "turn_end"]);
    expect(seen).toEqual([stub]);
    expect(order).toEqual(["onSession", "send"]);
  });

  test("does not reach createAgentSession when option construction fails", async () => {
    deps.nativeBackend = mock(() => {
      throw new NaxError("bad options", "TEST_FAILURE", { stage: "test" });
    });
    await expect(run()).rejects.toThrow("bad options");
    expect(sessionCalls).toEqual([]);
  });
});

describe("runSubagent terminal results", () => {
  test("AC-4 AC-12 completed with output returns the content and closes once", async () => {
    expect(await run()).toEqual({ content: "done" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("AC-5 completed with empty output returns the no-text placeholder", async () => {
    stub = sessionEnding(turnEnd(""));
    expect(await run()).toEqual({ content: "(the subagent returned no text)" });
  });

  test("AC-6 AC-16 errored returns the error message and closes once", async () => {
    stub = sessionEnding(turnEnd("", "errored", { code: "X", message: "boom" }));
    expect(await run()).toEqual({ isError: true, content: "subagent reviewer errored: boom" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test.each<[string, TurnEndStatus]>([
    ["AC-7", "cancelled"],
    ["AC-8", "timed_out"],
    ["AC-20", "interrupted"],
  ])("%s %s with no error falls back to the status and AC-21 closes once", async (_ac, status) => {
    stub = sessionEnding(turnEnd("", status));
    expect(await run()).toEqual({ isError: true, content: `subagent reviewer ${status}: ${status}` });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("a turn that ends without turn_end is reported as a failure", async () => {
    stub = {
      ...stub,
      async *send() {
        yield textDelta("partial");
      },
    };
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("[chat] subagent reviewer failed:");
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("runSubagent cancellation", () => {
  test("AC-9 aborting the signal during the turn calls the session's cancel", async () => {
    const controller = new AbortController();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = mock(() => release());
    stub = {
      ...stub,
      cancel,
      async *send() {
        controller.abort();
        await gate;
        yield turnEnd("", "cancelled");
      },
    };
    const result = await run({ signal: controller.signal });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ isError: true, content: "subagent reviewer cancelled: cancelled" });
  });

  test("AC-10 AC-11 an already-aborted signal returns cancelled without creating a session", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run({ signal: controller.signal });
    expect(result).toEqual({ isError: true, content: "subagent reviewer cancelled: cancelled" });
    expect(deps.createAgentSession).not.toHaveBeenCalled();
  });

  test("an abort that lands while the session is being created sends nothing and closes", async () => {
    const controller = new AbortController();
    const send = mock(async function* (_message: string) {
      yield turnEnd("done");
    });
    stub = { ...stub, send };
    deps.createAgentSession = mock(async () => {
      controller.abort();
      return stub;
    });
    const result = await run({ signal: controller.signal });
    expect(result).toEqual({ isError: true, content: "subagent reviewer cancelled: cancelled" });
    expect(send).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("detaches the abort listener after the turn", async () => {
    const controller = new AbortController();
    const cancel = mock(() => {});
    stub = { ...stub, cancel };
    await run({ signal: controller.signal });
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("runSubagent failures", () => {
  test("AC-17 AC-18 a send that throws on iteration is a failed result and closes once", async () => {
    stub = {
      ...stub,
      // biome-ignore lint/correctness/useYield: the throw is the behaviour under test
      async *send() {
        throw new Error("x");
      },
    };
    expect(await run()).toEqual({ isError: true, content: "[chat] subagent reviewer failed: x" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("AC-17 AC-18 a send that throws synchronously is a failed result and closes once", async () => {
    stub = {
      ...stub,
      send() {
        throw new Error("x");
      },
    };
    expect(await run()).toEqual({ isError: true, content: "[chat] subagent reviewer failed: x" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("AC-19 a createAgentSession that throws is a failed result", async () => {
    deps.createAgentSession = mock(async () => {
      throw new Error("bad model");
    });
    expect(await run()).toEqual({ isError: true, content: "[chat] subagent reviewer failed: bad model" });
    expect(closed).not.toHaveBeenCalled();
  });

  test("a close that throws does not replace the turn's result", async () => {
    closed = mock(async () => {
      throw new Error("close failed");
    });
    stub = { ...stub, close: closed };
    expect(await run()).toEqual({ content: "done" });
  });
});

describe("runSubagent resolved posture", () => {
  test("AC-16/17/18/21 guarded resolves once and forwards posture without host ports", async () => {
    const posture = { bashApproval: "raw", askRules: ["Write"], denyRules: ["Delete(src/**)"] } as const;
    deps.resolveTuiPermissions = mock(() => posture);
    await run();
    expect(deps.resolveTuiPermissions).toHaveBeenCalledTimes(1);
    expect(deps.resolveTuiPermissions).toHaveBeenCalledWith(input.config);
    expect(backendOptions()).toMatchObject({
      bashApproval: "raw",
      sandbox: input.config.execution.sandbox,
      askRules: posture.askRules,
      denyRules: posture.denyRules,
      askOnUnsandboxed: true,
      askWhenSandboxDown: true,
      askDiscoveredTools: true,
    });
    expect(backendOptions().askRules).toBe(posture.askRules);
    expect(backendOptions().denyRules).toBe(posture.denyRules);
    expect(sessionOptions().profile).toBe("full");
    expect(backendOptions()).not.toHaveProperty("hostPorts");
  });
  test("AC-19/20 full skips resolution and has only the sandbox posture", async () => {
    await run({ mode: "full" });
    expect(deps.resolveTuiPermissions).not.toHaveBeenCalled();
    expect(backendOptions().sandbox).toBe(input.config.execution.sandbox);
    for (const key of ["askRules", "denyRules", "askOnUnsandboxed", "askWhenSandboxDown", "askDiscoveredTools"]) {
      expect(backendOptions()).not.toHaveProperty(key);
    }
  });
});
