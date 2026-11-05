import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type CreateAgentSessionOptions,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type LoopHandlerSet,
  type SessionBackend,
  type ToolProvider,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import type { AcpBackendOptions } from "@nathapp/nax-agent-acp/client";
import { makeNaxConfig } from "@test/helpers";
import type { AcpSubagentProfile } from "@/chat/acp/acp-subagent-profile";
import {
  _acpSubagentDeps,
  ACP_SUBAGENT_PROVIDER_IDS,
  acpSubagentSessionOptions,
} from "@/chat/acp/acp-subagent-session";
import type { ChatAcpTools } from "@/chat/acp/acp-tools";
import { NaxError } from "@/errors";
import { buildAcpSubagentInstructions } from "@/prompts";
import type { AgentResource } from "@/resources";

type Input = Parameters<typeof acpSubagentSessionOptions>[0];

const AGENT_PROMPT = "Review the diff carefully.";
const agent: AgentResource = {
  kind: "agent",
  name: "spec-reviewer",
  qualifiedName: "spec-reviewer",
  description: "Reviews specs",
  prompt: AGENT_PROMPT,
  path: "/repo/.claude/agents/spec-reviewer.md",
  origin: { kind: "claude-project" },
};
const backend: SessionBackend = {
  kind: "acp:codex",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};
const loopHandlers: LoopHandlerSet = [];
const store: TranscriptStore = createMemoryTranscriptStore();

function provider(id: string): ToolProvider {
  return { id, kind: "static", stages: ["chat"], tools: async () => [] };
}

/** The four `nax-memory` tools, in the order the provider lists them. */
function memoryTools(): readonly EmbedderTool[] {
  return ["get", "search", "save", "forget"].map((name) => ({
    name: `nax-memory__${name}`,
    description: `memory ${name}`,
    inputSchema: { type: "object", properties: {} },
    approval: "never",
    run: async () => ({ content: "ok" }),
  }));
}

const original = { ..._acpSubagentDeps };
let acpBackendMock: ReturnType<typeof mock<(options: AcpBackendOptions) => SessionBackend>>;
let chatAcpToolsMock: ReturnType<
  typeof mock<(providers: readonly ToolProvider[], workdir: string) => Promise<ChatAcpTools>>
>;
let transcriptStoreMock: ReturnType<typeof mock<() => TranscriptStore>>;

beforeEach(() => {
  acpBackendMock = mock((_options: AcpBackendOptions) => backend);
  chatAcpToolsMock = mock(
    async (_providers: readonly ToolProvider[], _workdir: string): Promise<ChatAcpTools> => ({
      tools: memoryTools(),
      instructions: "TOOL-TEXT",
    }),
  );
  transcriptStoreMock = mock(() => store);
  _acpSubagentDeps.acpBackend = acpBackendMock;
  _acpSubagentDeps.chatAcpTools = chatAcpToolsMock;
});

afterEach(() => {
  Object.assign(_acpSubagentDeps, original);
});

function input(overrides: Partial<Input> = {}): Input {
  return {
    agent,
    task: "review the spec",
    mode: "guarded",
    model: "acp:codex/gpt-6.1-terra",
    toolProviders: [provider("nax-workflow"), provider("nax-jobs"), provider("nax-memory"), provider("custom")],
    loopHandlers,
    cwd: "/repo/work",
    repoRoot: "/repo",
    config: makeNaxConfig(),
    parentSessionId: "chat-1",
    onEvent: () => {},
    acp: { agent: "codex" },
    profile: "review",
    ...overrides,
  };
}

function options(overrides: Partial<Input> = {}): Promise<CreateAgentSessionOptions> {
  return acpSubagentSessionOptions(input(overrides), transcriptStoreMock);
}

function deliveredProviderIds(): readonly string[] {
  return (chatAcpToolsMock.mock.calls[0]?.[0] ?? []).map((entry) => entry.id);
}

function toolNames(options: CreateAgentSessionOptions): readonly string[] {
  return (options.tools ?? []).map((tool) => tool.name);
}

describe("ACP_SUBAGENT_PROVIDER_IDS", () => {
  test("delivers the workflow and memory providers, never jobs", () => {
    expect(ACP_SUBAGENT_PROVIDER_IDS).toEqual(["nax-workflow", "nax-memory"]);
  });
});

describe("acpSubagentSessionOptions backend", () => {
  test("AC-3: calls acpBackend once with the model, effort and ACP delivery posture", async () => {
    await options({ acp: { agent: "codex", model: "gpt-6.1-terra", effort: "high" } });
    expect(acpBackendMock).toHaveBeenCalledTimes(1);
    expect(acpBackendMock.mock.calls[0]?.[0]).toEqual({
      agent: "codex",
      model: "gpt-6.1-terra",
      effort: "high",
      allowUnsandboxed: true,
      inheritEnv: true,
    });
  });

  test("omits model and effort when the ACP model names neither", async () => {
    await options({ acp: { agent: "cursor" } });
    const arg = acpBackendMock.mock.calls[0]?.[0];
    expect(arg).toEqual({ agent: "cursor", allowUnsandboxed: true, inheritEnv: true });
    expect(Object.keys(arg ?? {}).sort()).toEqual(["agent", "allowUnsandboxed", "inheritEnv"]);
  });

  test("returns the backend the factory built", async () => {
    expect((await options()).backend).toBe(backend);
  });
});

describe("acpSubagentSessionOptions session shape", () => {
  test("AC-4: a review profile opens read-only with no sessionId and the input cwd", async () => {
    const created = await options({ profile: "review", cwd: "/repo/elsewhere" });
    expect(created.profile).toBe("review");
    expect("sessionId" in created).toBe(false);
    expect(created.workdir).toBe("/repo/elsewhere");
  });

  test.each<[AcpSubagentProfile]>([["read"], ["ask"], ["full"]])("carries profile %s through", async (profile) => {
    expect((await options({ profile })).profile).toBe(profile);
  });

  test("AC-5: metadata names the parent session and the subagent", async () => {
    const created = await options({ parentSessionId: "chat-9" });
    expect(created.metadata).toEqual({ parentSessionId: "chat-9", subagent: "spec-reviewer" });
  });

  test("takes the approval timeout from config", async () => {
    const created = await options({ config: makeNaxConfig({ execution: { approvalTimeout: 777_000 } }) });
    expect(created.approvalTimeoutMs).toBe(777_000);
  });
});

describe("acpSubagentSessionOptions provider delivery", () => {
  test("AC-6: passes only the nax-workflow and nax-memory providers", async () => {
    await options();
    expect(deliveredProviderIds()).toEqual(["nax-workflow", "nax-memory"]);
  });

  test("AC-7: an allowedTools list keeps only the providers it names", async () => {
    await options({ allowedTools: ["Read", "nax-memory__*"] });
    expect(deliveredProviderIds()).toEqual(["nax-memory"]);
  });

  test("a built-in-only allowedTools list delivers no nax provider at all", async () => {
    await options({ allowedTools: ["Read", "Grep"] });
    expect(deliveredProviderIds()).toEqual([]);
  });

  test("an empty allowedTools list delivers no provider", async () => {
    await options({ allowedTools: [] });
    expect(deliveredProviderIds()).toEqual([]);
  });
});

describe("acpSubagentSessionOptions skills for an unattended run", () => {
  const providers = [provider("nax-skills"), provider("nax-workflow"), provider("nax-jobs")];

  test("US-001 AC-11: an unattended run also delivers nax-skills, and still not nax-jobs", async () => {
    await options({ unattended: true, toolProviders: providers });
    expect(deliveredProviderIds()).toEqual(["nax-skills", "nax-workflow"]);
  });

  test("US-001 AC-12: an attended run delivers only nax-workflow", async () => {
    await options({ toolProviders: providers });
    expect(deliveredProviderIds()).toEqual(["nax-workflow"]);
  });
});

describe("acpSubagentSessionOptions read-only memory safety", () => {
  test("AC-8: review keeps the memory reads and drops save and forget", async () => {
    const created = await options({ profile: "review" });
    expect(toolNames(created)).toEqual(["nax-memory__get", "nax-memory__search"]);
  });

  test("read is read-only too", async () => {
    expect(toolNames(await options({ profile: "read" }))).toEqual(["nax-memory__get", "nax-memory__search"]);
  });

  test("AC-9: ask keeps all four memory tools", async () => {
    const created = await options({ profile: "ask" });
    expect(toolNames(created)).toEqual([
      "nax-memory__get",
      "nax-memory__search",
      "nax-memory__save",
      "nax-memory__forget",
    ]);
  });

  test("full keeps all four memory tools", async () => {
    expect(toolNames(await options({ profile: "full" }))).toHaveLength(4);
  });

  test("a tool outside the memory provider survives a read-only profile", async () => {
    const workflowTool: EmbedderTool = {
      name: "nax-workflow__state",
      description: "workflow state",
      inputSchema: { type: "object", properties: {} },
      approval: "never",
      run: async () => ({ content: "ok" }),
    };
    chatAcpToolsMock.mockImplementation(async () => ({ tools: [...memoryTools(), workflowTool] }));
    expect(toolNames(await options({ profile: "review" }))).toEqual([
      "nax-memory__get",
      "nax-memory__search",
      "nax-workflow__state",
    ]);
  });
});

describe("acpSubagentSessionOptions instructions and transcript", () => {
  test("AC-10: returns the store the factory made and the ACP subagent instructions", async () => {
    const memoryIndex = "# Memory\n- [project] a — b";
    const created = await options({ memoryIndex });
    expect(transcriptStoreMock).toHaveBeenCalledTimes(1);
    expect(created.transcriptStore).toBe(store);
    expect(created.instructions).toBe(
      buildAcpSubagentInstructions({
        agentLabel: "Codex",
        agent,
        toolInstructions: "TOOL-TEXT",
        memoryIndex,
      }),
    );
  });

  test("no tool instructions and no memory index yields the bare instructions", async () => {
    chatAcpToolsMock.mockImplementation(async () => ({ tools: [] }));
    expect((await options()).instructions).toBe(buildAcpSubagentInstructions({ agentLabel: "Codex", agent }));
  });
});

describe("acpSubagentSessionOptions dependency failures", () => {
  test("AC-11: rejects with the error chatAcpTools threw", async () => {
    const boom = new Error("boom");
    chatAcpToolsMock.mockImplementation(async () => {
      throw boom;
    });
    await expect(acpSubagentSessionOptions(input(), transcriptStoreMock)).rejects.toBe(boom);
    expect(acpBackendMock).not.toHaveBeenCalled();
  });
});
