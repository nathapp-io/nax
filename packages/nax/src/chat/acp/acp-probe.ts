import { createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";
import { buildAcpChatEnv } from "@/agents/shared";
import type { AcpChatAgent } from "./acp-model";

export const ACP_PROBE_TIMEOUT_MS = 20_000;
export const _acpProbeDeps = { createAgentSession, acpBackend, createMemoryTranscriptStore };

/** Opens a tool-less, memory-only ACP session and closes it without sending a turn. */
export async function probeAcpAgent(input: {
  readonly agent: AcpChatAgent;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<Readonly<Record<string, unknown>>> {
  const session = await _acpProbeDeps.createAgentSession({
    backend: _acpProbeDeps.acpBackend({
      agent: input.agent,
      allowUnsandboxed: true,
      inheritEnv: false,
      env: buildAcpChatEnv(input.agent),
      initializeTimeoutMs: ACP_PROBE_TIMEOUT_MS,
    }),
    profile: "ask",
    workdir: input.cwd,
    tools: [],
    transcriptStore: _acpProbeDeps.createMemoryTranscriptStore(),
    ...(input.signal === undefined ? {} : { openSignal: input.signal }),
  });
  try {
    return session.backend.capabilities;
  } finally {
    // Discovery remains useful even if the short-lived session cannot close cleanly.
    await session.close().catch(() => undefined);
  }
}
