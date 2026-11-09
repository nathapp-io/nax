import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession } from "@nathapp/nax-agent";
import type { AcpBackendOptions } from "@nathapp/nax-agent-acp/client";
import { withEnvVars } from "@test/helpers";
import { _acpProbeDeps, ACP_PROBE_TIMEOUT_MS, probeAcpAgent } from "@/chat/acp/acp-probe";

const original = { ..._acpProbeDeps };
afterEach(() => Object.assign(_acpProbeDeps, original));

function fixture() {
  const capabilities = { offeredModels: ["m"] };
  const close = mock(async () => {});
  const session: AgentSession = {
    id: "probe",
    backend: { kind: "acp", capabilities },
    lastTurn: undefined,
    async *send() {},
    answer: () => "unknown",
    cancel() {},
    close,
  };
  const backend = original.acpBackend({ agent: "codex", allowUnsandboxed: true });
  const store = original.createMemoryTranscriptStore();
  const acpBackend = mock((_options: AcpBackendOptions) => backend);
  const createAgentSession = mock(async (_options: Parameters<typeof original.createAgentSession>[0]) => session);
  const createMemoryTranscriptStore = mock(() => store);
  Object.assign(_acpProbeDeps, { acpBackend, createAgentSession, createMemoryTranscriptStore });
  return { capabilities, close, backend, store, acpBackend, createAgentSession, createMemoryTranscriptStore };
}

describe("probeAcpAgent", () => {
  test("close AC-1 forwards the caller's open signal exactly once", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await probeAcpAgent({ agent: "codex", cwd: "/r", signal });
    expect(f.createAgentSession).toHaveBeenCalledTimes(1);
    expect(f.createAgentSession.mock.calls[0]?.[0].openSignal).toBe(signal);
  });

  test("close AC-2 omits openSignal when no signal is supplied", async () => {
    const f = fixture();
    await probeAcpAgent({ agent: "codex", cwd: "/r" });
    expect(f.createAgentSession).toHaveBeenCalledTimes(1);
    expect(f.createAgentSession.mock.calls[0]?.[0]).not.toHaveProperty("openSignal");
  });
  test("AC-1/2/3/18 opens a tool-less memory session with per-step timeout and closes it", async () => {
    const f = fixture();
    expect(await probeAcpAgent({ agent: "codex", cwd: "/r" })).toBe(f.capabilities);
    expect(ACP_PROBE_TIMEOUT_MS).toBe(20_000);
    expect(f.acpBackend).toHaveBeenCalledTimes(1);
    const arg = f.acpBackend.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      agent: "codex",
      allowUnsandboxed: true,
      inheritEnv: false,
      initializeTimeoutMs: ACP_PROBE_TIMEOUT_MS,
    });
    expect(Object.keys(arg ?? {}).sort()).toEqual([
      "agent",
      "allowUnsandboxed",
      "env",
      "inheritEnv",
      "initializeTimeoutMs",
    ]);
    expect(Object.values(arg?.env ?? {}).every((value) => typeof value === "string")).toBe(true);
    expect(f.createAgentSession).toHaveBeenCalledTimes(1);
    expect(f.createAgentSession).toHaveBeenCalledWith({
      backend: f.backend,
      profile: "ask",
      workdir: "/r",
      tools: [],
      transcriptStore: f.store,
    });
    expect(f.createMemoryTranscriptStore).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  test("US-002 AC-8: the probe's backend gets an explicit env that withholds nax's secrets", async () => {
    const f = fixture();
    await withEnvVars({ NAX_TELEGRAM_TOKEN: "nax-secret" }, () => probeAcpAgent({ agent: "codex", cwd: "/r" }));
    expect(f.acpBackend).toHaveBeenCalledTimes(1);
    const arg = f.acpBackend.mock.calls[0]?.[0];
    expect(arg?.inheritEnv).toBe(false);
    expect(arg?.env).not.toHaveProperty("NAX_TELEGRAM_TOKEN");
  });
  test("AC-4 returns capabilities even when close rejects", async () => {
    const f = fixture();
    f.close.mockRejectedValue(new Error("close failed"));
    expect(await probeAcpAgent({ agent: "codex", cwd: "/r" })).toBe(f.capabilities);
  });
  test("AC-5 preserves open rejection", async () => {
    const f = fixture();
    const error = new Error("open failed");
    f.createAgentSession.mockRejectedValue(error);
    await expect(probeAcpAgent({ agent: "codex", cwd: "/r" })).rejects.toBe(error);
    expect(f.close).not.toHaveBeenCalled();
  });
});
