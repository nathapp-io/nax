import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession } from "@nathapp/nax-agent";
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
  const acpBackend = mock(() => backend);
  const createAgentSession = mock(async () => session);
  const createMemoryTranscriptStore = mock(() => store);
  Object.assign(_acpProbeDeps, { acpBackend, createAgentSession, createMemoryTranscriptStore });
  return { capabilities, close, backend, store, acpBackend, createAgentSession, createMemoryTranscriptStore };
}

describe("probeAcpAgent", () => {
  test("AC-1/2/3/18 opens a tool-less memory session with per-step timeout and closes it", async () => {
    const f = fixture();
    expect(await probeAcpAgent({ agent: "codex", cwd: "/r" })).toBe(f.capabilities);
    expect(ACP_PROBE_TIMEOUT_MS).toBe(20_000);
    expect(f.acpBackend).toHaveBeenCalledTimes(1);
    expect(f.acpBackend).toHaveBeenCalledWith({
      agent: "codex",
      allowUnsandboxed: true,
      inheritEnv: true,
      initializeTimeoutMs: ACP_PROBE_TIMEOUT_MS,
    });
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
