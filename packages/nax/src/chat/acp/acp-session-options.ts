/**
 * Session options for an ACP chat brain.
 *
 * The agent gets the whole environment and none of nax's own sandbox, rules,
 * command shadow, background-command port or loop handlers: the agent's own
 * settings apply. Guarded mode opens ACP profile `ask`, full mode `full`.
 */

import { join } from "node:path";
import type { CreateAgentSessionOptions, ToolProvider } from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";
import { NaxError } from "@/errors";
import { buildChatAcpInstructions } from "@/prompts";
import type { ChatMode } from "../chat-mode";
import { type AcpChatAgent, acpAgentLabel, type ChatAcpModel } from "./acp-model";
import { chatAcpTools } from "./acp-tools";

/** Seams for tests: the ACP backend factory and the workflow-tool resolver. */
export const _acpSessionDeps = { acpBackend, chatAcpTools };

/** Agent-session error codes meaning the stored agent session is unusable. */
const UNUSABLE_SESSION_CODES: ReadonlySet<string> = new Set([
  "AGENT_SESSION_NOT_FOUND",
  "AGENT_SESSION_BACKEND_MISMATCH",
  "TRANSCRIPT_CORRUPT",
]);
const CAPABILITY_UNSUPPORTED = "AGENT_SESSION_CAPABILITY_UNSUPPORTED";

/** True for an error that means the stored agent session is unusable, so a fresh one may replace it. */
export function isFreshFallback(error: unknown): boolean {
  if (!(error instanceof NaxError)) return false;
  if (UNUSABLE_SESSION_CODES.has(error.code)) return true;
  return error.code === CAPABILITY_UNSUPPORTED && error.context?.capability === "resume";
}

export function ACP_FRESH_SESSION_NOTICE(label: string): string {
  return `${label}'s earlier session could not be resumed; it starts a new one`;
}

/** Where an ACP agent's transcript documents live under the chat sessions dir. */
export function acpTranscriptDir(sessionsDir: string, agent: AcpChatAgent): string {
  return join(sessionsDir, `acp-${agent}`);
}

export interface AcpSessionOptionsInput {
  readonly acp: ChatAcpModel;
  readonly mode: ChatMode;
  readonly sessionId: string;
  readonly cwd: string;
  readonly toolProviders: readonly ToolProvider[];
  readonly approvalTimeoutMs?: number;
}

export async function acpSessionOptions(
  input: AcpSessionOptionsInput,
): Promise<Omit<CreateAgentSessionOptions, "transcriptStore">> {
  const { acp } = input;
  const resolved = await _acpSessionDeps.chatAcpTools(input.toolProviders, input.cwd);
  return {
    backend: _acpSessionDeps.acpBackend({
      agent: acp.agent,
      allowUnsandboxed: true,
      inheritEnv: true,
      ...(acp.model !== undefined ? { model: acp.model } : {}),
      ...(acp.effort !== undefined ? { effort: acp.effort } : {}),
    }),
    sessionId: input.sessionId,
    profile: input.mode === "full" ? "full" : "ask",
    workdir: input.cwd,
    tools: resolved.tools,
    instructions: buildChatAcpInstructions({
      agentLabel: acpAgentLabel(acp.agent),
      ...(resolved.instructions !== undefined ? { toolInstructions: resolved.instructions } : {}),
    }),
    ...(input.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: input.approvalTimeoutMs } : {}),
  };
}
