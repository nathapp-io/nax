import { afterEach, beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
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
import type { AcpBackendOptions } from "@nathapp/nax-agent-acp/client";
import { makeNaxConfig } from "@test/helpers";
import {
  type RunSubagentInput as BarrelRunSubagentInput,
  type RunSubagentResult as BarrelRunSubagentResult,
  runSubagent as runSubagentFromBarrel,
} from "@/chat";
import { _acpSubagentDeps } from "@/chat/acp";
import type { ChatAcpTools } from "@/chat/acp/acp-tools";
import { type _subagentSessionDeps, type RunSubagentInput, runSubagent } from "@/chat/subagent-session";
import type { TuiPermissions } from "@/config";
import { NaxError } from "@/errors";
import type { AgentResource } from "@/resources";

const AGENT_PROMPT = "Review the diff carefully.";
const QUALIFIED_NAME = "spec-reviewer";
const acpBackendSession: SessionBackend = {
  kind: "acp:codex",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};
const store = createMemoryTranscriptStore();
const loopHandlers: LoopHandlerSet = [];

function agentWith(tools?: readonly string[]): AgentResource {
  return {
    kind: "agent",
    name: QUALIFIED_NAME,
    qualifiedName: QUALIFIED_NAME,
    description: "Reviews specs",
    prompt: AGENT_PROMPT,
    path: "/repo/.claude/agents/spec-reviewer.md",
    origin: { kind: "claude-project" },
    ...(tools !== undefined ? { tools } : {}),
  };
}

function turnEnd(output: string, status: TurnEndStatus = "completed"): SessionEvent {
  return {
    sessionId: "s",
    turnId: "t",
    at: "2026-10-01T00:00:00.000Z",
    metadata: {},
    type: "turn_end",
    status,
    output,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
  };
}

function provider(id: string): ToolProvider {
  return { id, kind: "static", stages: ["chat"], tools: async () => [] };
}

type AcpToolsMock = Mock<(providers: readonly ToolProvider[], workdir: string) => Promise<ChatAcpTools>>;
type AcpBackendMock = Mock<(options: AcpBackendOptions) => SessionBackend>;
type NativeBackendOptions = Parameters<(typeof _subagentSessionDeps)["nativeBackend"]>[0];

const originalAcpDeps = { ..._acpSubagentDeps };
let acpBackendMock: AcpBackendMock;
let chatAcpToolsMock: AcpToolsMock;
let stub: AgentSession;
let closed: Mock<() => Promise<void>>;
let sessionCalls: CreateAgentSessionOptions[];
let deps: typeof _subagentSessionDeps;
let input: RunSubagentInput;

function sessionOptions(): CreateAgentSessionOptions {
  const [options] = sessionCalls;
  if (options === undefined) throw new Error("createAgentSession was not called");
  return options;
}

beforeEach(() => {
  acpBackendMock = mock((_options: AcpBackendOptions) => acpBackendSession);
  chatAcpToolsMock = mock(
    async (_providers: readonly ToolProvider[], _workdir: string): Promise<ChatAcpTools> => ({ tools: [] }),
  );
  _acpSubagentDeps.acpBackend = acpBackendMock;
  _acpSubagentDeps.chatAcpTools = chatAcpToolsMock;

  closed = mock(async () => {});
  sessionCalls = [];
  stub = {
    id: "sub-1",
    backend: { kind: "acp:codex", capabilities: {} },
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
    nativeBackend: mock((_options: NativeBackendOptions) => acpBackendSession),
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
    agent: agentWith(["Read"]),
    task: "review the spec",
    mode: "guarded",
    model: "acp:codex/gpt-6.1-terra",
    toolProviders: [provider("nax-memory")],
    loopHandlers,
    cwd: "/repo",
    repoRoot: "/repo",
    config: makeNaxConfig(),
    parentSessionId: "chat-1",
    onEvent: () => {},
  };
});

afterEach(() => {
  Object.assign(_acpSubagentDeps, originalAcpDeps);
});

const run = (overrides: Partial<RunSubagentInput> = {}) => runSubagent({ ...input, ...overrides }, deps);

describe("runSubagent ACP transport", () => {
  test("AC-1: a read-only agent on an ACP model opens through ACP with profile review", async () => {
    const result = await run();
    expect(result.isError).toBeUndefined();
    expect(sessionOptions().profile).toBe("review");
    expect(deps.createAgentSession).toHaveBeenCalledTimes(1);
    expect(deps.createMemoryTranscriptStore).toHaveBeenCalledTimes(1);
    expect(deps.nativeBackend).not.toHaveBeenCalled();
    expect(acpBackendMock).toHaveBeenCalledTimes(1);
    expect(acpBackendMock.mock.calls[0]?.[0]).toEqual({
      agent: "codex",
      model: "gpt-6.1-terra",
      allowUnsandboxed: true,
      inheritEnv: true,
    });
  });

  test("consumes the operator's acpSubagents profile override", async () => {
    await run({ config: makeNaxConfig({ agent: { acpSubagents: { profile: "full" } } }) });
    expect(sessionOptions().profile).toBe("full");
  });

  test("AC-4: a write tool on a cursor model opens with profile ask", async () => {
    await run({ model: "acp:cursor", agent: agentWith(["Read", "Edit"]) });
    expect(sessionOptions().profile).toBe("ask");
    expect(acpBackendMock.mock.calls[0]?.[0]).toEqual({ agent: "cursor", allowUnsandboxed: true, inheritEnv: true });
  });
});

describe("runSubagent ACP read-only refusal", () => {
  const refusal =
    "[chat] subagent spec-reviewer could not start read-only: Cursor has no read-only enforcement of its own";

  test("AC-2: a cursor subagent that would be read-only is refused with the exact message", async () => {
    const result = await run({ model: "acp:cursor", agent: agentWith(["Read"]) });
    expect(result).toEqual({ isError: true, content: refusal });
  });

  test("AC-3: the refusal creates no session and builds no backend", async () => {
    await run({ model: "acp:cursor", agent: agentWith(["Read"]) });
    expect(deps.createAgentSession).not.toHaveBeenCalled();
    expect(acpBackendMock).not.toHaveBeenCalled();
    expect(chatAcpToolsMock).not.toHaveBeenCalled();
  });
});

describe("runSubagent ACP failure conversion", () => {
  test("AC-5: a malformed acp: model is a failed result and creates no session", async () => {
    const result = await run({ model: "acp:bogus" });
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith(`[chat] subagent ${QUALIFIED_NAME} failed:`);
    expect(result.content).toContain("invalid ACP model");
    expect(deps.createAgentSession).not.toHaveBeenCalled();
  });

  test("AC-6: a rejecting tool resolver is a failed result and creates no session", async () => {
    chatAcpToolsMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    const result = await run();
    expect(result).toEqual({ isError: true, content: `[chat] subagent ${QUALIFIED_NAME} failed: boom` });
    expect(deps.createAgentSession).not.toHaveBeenCalled();
  });

  test("AC-7: a createAgentSession that throws is a failed result", async () => {
    deps.createAgentSession = mock(async () => {
      throw new Error("spawn codex-acp ENOENT");
    });
    const result = await run();
    expect(result).toEqual({
      isError: true,
      content: `[chat] subagent ${QUALIFIED_NAME} failed: spawn codex-acp ENOENT`,
    });
  });

  test("AC-11: an acpBackend that throws while options are built is a failed result", async () => {
    acpBackendMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const result = await run();
    expect(result).toEqual({ isError: true, content: `[chat] subagent ${QUALIFIED_NAME} failed: boom` });
    expect(deps.createAgentSession).not.toHaveBeenCalled();
  });

  test("AC-12: a native model still rejects when native option construction throws", async () => {
    deps.nativeBackend = mock((_options: NativeBackendOptions) => {
      throw new NaxError("bad options", "TEST_FAILURE", { stage: "test" });
    });
    await expect(run({ model: "anthropic/sonnet" })).rejects.toThrow("bad options");
    expect(deps.createAgentSession).not.toHaveBeenCalled();
    expect(acpBackendMock).not.toHaveBeenCalled();
  });
});

describe("runSubagent unattended", () => {
  test("US-001 AC-8: an agent with no tools line opens through ACP with profile review", async () => {
    const result = await run({ model: "acp:claude", agent: agentWith(undefined), unattended: true });
    expect(result.isError).toBeUndefined();
    expect(sessionOptions().profile).toBe("review");
    expect(deps.createAgentSession).toHaveBeenCalledTimes(1);
  });

  test("US-001 AC-9: an agent with no tools line is refused on an agent with no read-only enforcement", async () => {
    const result = await run({ model: "acp:cursor", agent: agentWith(undefined), unattended: true });
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith(`[chat] subagent ${QUALIFIED_NAME} could not start read-only:`);
    expect(deps.createAgentSession).not.toHaveBeenCalled();
  });
});

describe("runSubagent from the chat barrel", () => {
  test("US-001 AC-10: an already-aborted signal is a cancelled result", async () => {
    const controller = new AbortController();
    controller.abort();
    const barrelInput: BarrelRunSubagentInput = { ...input, signal: controller.signal };
    const result: BarrelRunSubagentResult = await runSubagentFromBarrel(barrelInput, deps);
    expect(result).toEqual({ isError: true, content: `subagent ${QUALIFIED_NAME} cancelled: cancelled` });
    expect(acpBackendMock).not.toHaveBeenCalled();
    expect(deps.createAgentSession).not.toHaveBeenCalled();
  });
});

describe("runSubagent ACP lifecycle", () => {
  test("AC-8: a completed turn returns the agent's output", async () => {
    stub = {
      ...stub,
      async *send() {
        yield turnEnd("LGTM");
      },
    };
    expect(await run()).toEqual({ content: "LGTM" });
  });

  test("AC-9: the nested session is closed exactly once after the turn", async () => {
    await run();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("AC-10: aborting the signal during the turn cancels the nested session", async () => {
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
    expect(result.isError).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("an already-aborted signal returns cancelled without building ACP options", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run({ signal: controller.signal });
    expect(result).toEqual({ isError: true, content: "subagent spec-reviewer cancelled: cancelled" });
    expect(acpBackendMock).not.toHaveBeenCalled();
    expect(deps.createAgentSession).not.toHaveBeenCalled();
  });
});
