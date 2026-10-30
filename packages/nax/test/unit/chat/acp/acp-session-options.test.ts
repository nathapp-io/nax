import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentSessionError, type EmbedderTool, type SessionBackend, type ToolProvider } from "@nathapp/nax-agent";
import type { AcpBackendOptions } from "@nathapp/nax-agent-acp/client";
import {
  _acpSessionDeps,
  ACP_FRESH_SESSION_NOTICE,
  acpSessionOptions,
  acpTranscriptDir,
  isFreshFallback,
} from "@/chat/acp/acp-session-options";
import type { ChatAcpTools } from "@/chat/acp/acp-tools";
import { NaxError } from "@/errors";
import { buildChatAcpInstructions } from "@/prompts";

type Input = Parameters<typeof acpSessionOptions>[0];

const backend: SessionBackend = {
  kind: "acp:test",
  async open() {
    throw new NaxError("unexpected backend open", "TEST_FAILURE", { stage: "test" });
  },
};
const tool: EmbedderTool = {
  name: "nax-workflow__state",
  description: "d",
  inputSchema: { type: "object", properties: {} },
  approval: "never",
  run: async () => ({ content: "ok" }),
};
const providers: readonly ToolProvider[] = [
  { id: "nax-workflow", kind: "static", stages: ["*"], tools: async () => [] },
];

const original = { ..._acpSessionDeps };
let acpBackendMock: ReturnType<typeof mock<(options: AcpBackendOptions) => SessionBackend>>;
let chatAcpToolsMock: ReturnType<
  typeof mock<(providers: readonly ToolProvider[], workdir: string) => Promise<ChatAcpTools>>
>;

beforeEach(() => {
  acpBackendMock = mock((_options: AcpBackendOptions) => backend);
  chatAcpToolsMock = mock(
    async (_providers: readonly ToolProvider[], _workdir: string): Promise<ChatAcpTools> => ({
      tools: [tool],
      instructions: "TOOL-TEXT",
    }),
  );
  _acpSessionDeps.acpBackend = acpBackendMock;
  _acpSessionDeps.chatAcpTools = chatAcpToolsMock;
});

afterEach(() => {
  Object.assign(_acpSessionDeps, original);
});

function input(overrides: Partial<Input> = {}): Input {
  return {
    acp: { agent: "codex", model: "gpt-5.5", effort: "high" },
    mode: "guarded",
    sessionId: "sess-1",
    cwd: "/repo/work",
    toolProviders: providers,
    approvalTimeoutMs: 1234,
    ...overrides,
  };
}

describe("acpTranscriptDir", () => {
  test("AC-1: joins acp-<agent> under the sessions dir", () => {
    expect(acpTranscriptDir("/s", "codex")).toBe("/s/acp-codex");
  });
});

describe("acpSessionOptions", () => {
  test("AC-2: opens the backend with model and effort", async () => {
    await acpSessionOptions(input());
    expect(acpBackendMock).toHaveBeenCalledTimes(1);
    expect(acpBackendMock.mock.calls[0]?.[0]).toEqual({
      agent: "codex",
      allowUnsandboxed: true,
      inheritEnv: true,
      model: "gpt-5.5",
      effort: "high",
    });
  });

  test("AC-3: omits model and effort keys when absent", async () => {
    await acpSessionOptions(input({ acp: { agent: "claude" } }));
    const arg = acpBackendMock.mock.calls[0]?.[0];
    expect(arg).toEqual({ agent: "claude", allowUnsandboxed: true, inheritEnv: true });
    expect(Object.keys(arg ?? {}).sort()).toEqual(["agent", "allowUnsandboxed", "inheritEnv"]);
  });

  test("returns the backend the factory built", async () => {
    expect((await acpSessionOptions(input())).backend).toBe(backend);
  });

  test("AC-4: guarded mode opens profile ask", async () => {
    expect((await acpSessionOptions(input({ mode: "guarded" }))).profile).toBe("ask");
  });

  test("AC-5: full mode opens profile full", async () => {
    expect((await acpSessionOptions(input({ mode: "full" }))).profile).toBe("full");
  });

  test("AC-6: returns the tools chatAcpTools resolved for the providers and cwd", async () => {
    const options = await acpSessionOptions(input());
    expect(chatAcpToolsMock).toHaveBeenCalledWith(providers, "/repo/work");
    expect(options.tools).toEqual([tool]);
  });

  test("AC-7: instructions come from buildChatAcpInstructions with the agent label and tool text", async () => {
    const options = await acpSessionOptions(input());
    expect(options.instructions).toBe(buildChatAcpInstructions({ agentLabel: "Codex", toolInstructions: "TOOL-TEXT" }));
  });

  test("AC-7: no tool instructions yields instructions without a tool section", async () => {
    chatAcpToolsMock.mockImplementation(async () => ({ tools: [] }));
    const options = await acpSessionOptions(input({ acp: { agent: "cursor" } }));
    expect(options.instructions).toBe(buildChatAcpInstructions({ agentLabel: "Cursor" }));
  });

  test("AC-8: returns sessionId from the input", async () => {
    expect((await acpSessionOptions(input({ sessionId: "abc" }))).sessionId).toBe("abc");
  });

  test("AC-9: returns approvalTimeoutMs from the input", async () => {
    expect((await acpSessionOptions(input({ approvalTimeoutMs: 777 }))).approvalTimeoutMs).toBe(777);
  });

  test("AC-9: omits approvalTimeoutMs when the input has none", async () => {
    const { approvalTimeoutMs: _omitted, ...rest } = input();
    const options = await acpSessionOptions(rest);
    expect("approvalTimeoutMs" in options).toBe(false);
  });

  test("AC-10: workdir equals the input cwd", async () => {
    expect((await acpSessionOptions(input({ cwd: "/x/y" }))).workdir).toBe("/x/y");
  });
});

describe("isFreshFallback", () => {
  test("AC-11: AGENT_SESSION_NOT_FOUND", () => {
    expect(isFreshFallback(new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND"))).toBe(true);
  });

  test("AC-12: AGENT_SESSION_BACKEND_MISMATCH", () => {
    expect(isFreshFallback(new AgentSessionError("other", "AGENT_SESSION_BACKEND_MISMATCH"))).toBe(true);
  });

  test("AC-13: NaxError TRANSCRIPT_CORRUPT", () => {
    expect(isFreshFallback(new NaxError("bad", "TRANSCRIPT_CORRUPT", { stage: "test" }))).toBe(true);
  });

  test("AC-14: CAPABILITY_UNSUPPORTED for resume", () => {
    const error = new AgentSessionError("no", "AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "resume" });
    expect(isFreshFallback(error)).toBe(true);
  });

  test("AC-15: CAPABILITY_UNSUPPORTED for model", () => {
    const error = new AgentSessionError("no", "AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "model" });
    expect(isFreshFallback(error)).toBe(false);
  });

  test("CAPABILITY_UNSUPPORTED without a capability is not a fallback", () => {
    expect(isFreshFallback(new AgentSessionError("no", "AGENT_SESSION_CAPABILITY_UNSUPPORTED"))).toBe(false);
  });

  test("AC-16: AGENT_SESSION_AUTH_REQUIRED", () => {
    expect(isFreshFallback(new AgentSessionError("auth", "AGENT_SESSION_AUTH_REQUIRED"))).toBe(false);
  });

  test("AC-17: AGENT_SESSION_BACKEND_UNAVAILABLE", () => {
    expect(isFreshFallback(new AgentSessionError("down", "AGENT_SESSION_BACKEND_UNAVAILABLE"))).toBe(false);
  });

  test("a non-NaxError value is not a fallback", () => {
    expect(isFreshFallback(new Error("x"))).toBe(false);
    expect(isFreshFallback("AGENT_SESSION_NOT_FOUND")).toBe(false);
    expect(isFreshFallback(undefined)).toBe(false);
  });
});

describe("ACP_FRESH_SESSION_NOTICE", () => {
  test("AC-18: names the agent label", () => {
    expect(ACP_FRESH_SESSION_NOTICE("Codex")).toBe("Codex's earlier session could not be resumed; it starts a new one");
  });
});
