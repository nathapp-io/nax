/**
 * Session options for an ACP subagent (chat-acp-subagents US-004).
 *
 * A subagent runs in an ephemeral session of the ACP agent its model names: no
 * `sessionId`, so it never resumes, and a fresh memory-only transcript store, so
 * nothing is written under the chat sessions dir. The ACP client enforces the
 * read-only profiles itself, so the profile is passed through unchanged.
 *
 * What crosses the ACP boundary from nax is narrow. Only the workflow and memory
 * providers are delivered — `nax-jobs` stays with the chat brain, because a
 * subagent must not launch billed runs — and, when the agent file names tools, only
 * the providers some `allowedTools` entry names with its `__` prefix. A read-only
 * subagent additionally loses the two memory writes: embedder tools carry
 * `approval: "never"` and the ACP client allows tool-host calls under every
 * profile, so without that removal a reviewer could save or forget notes unasked.
 *
 * A dependency failure rejects from here; turning one into a subagent error result
 * belongs to `runSubagent` (US-005).
 */

import type { CreateAgentSessionOptions, EmbedderTool, ToolProvider, TranscriptStore } from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";
import { MEMORY_TOOL_PROVIDER_ID } from "@/memory";
import { buildAcpSubagentInstructions } from "@/prompts";
import type { RunSubagentInput } from "../subagent-session";
import { acpAgentLabel, type ChatAcpModel } from "./acp-model";
import { type AcpSubagentProfile, isReadOnlyAcpProfile } from "./acp-subagent-profile";
import { chatAcpTools } from "./acp-tools";

/** Seams for tests: the ACP backend factory and the provider-tool resolver. */
export const _acpSubagentDeps = { acpBackend, chatAcpTools };

/**
 * Provider ids a subagent may be handed. `nax-jobs` is deliberately absent: a
 * billed launch stays with the chat brain, which the person is talking to.
 */
export const ACP_SUBAGENT_PROVIDER_IDS: readonly string[] = ["nax-workflow", "nax-memory"];

/** The memory writes a read-only subagent must not be handed. */
const READ_ONLY_WITHHELD_TOOL_NAMES: ReadonlySet<string> = new Set([
  `${MEMORY_TOOL_PROVIDER_ID}__save`,
  `${MEMORY_TOOL_PROVIDER_ID}__forget`,
]);

export type AcpSubagentSessionInput = RunSubagentInput & {
  readonly acp: ChatAcpModel;
  readonly profile: AcpSubagentProfile;
};

/** True when the agent's `tools:` list names this provider; an absent list names every provider. */
function namedByAllowedTools(allowedTools: readonly string[] | undefined, providerId: string): boolean {
  if (allowedTools === undefined) return true;
  return allowedTools.some((entry) => entry.startsWith(`${providerId}__`));
}

/** The chat's providers this subagent may see, in the order the chat listed them. */
function deliveredProviders(input: AcpSubagentSessionInput): readonly ToolProvider[] {
  return input.toolProviders.filter(
    (provider) =>
      ACP_SUBAGENT_PROVIDER_IDS.includes(provider.id) && namedByAllowedTools(input.allowedTools, provider.id),
  );
}

/** The resolved tools, minus the memory writes when the profile admits no write. */
function subagentTools(tools: readonly EmbedderTool[], profile: AcpSubagentProfile): readonly EmbedderTool[] {
  if (!isReadOnlyAcpProfile(profile)) return tools;
  return tools.filter((tool) => !READ_ONLY_WITHHELD_TOOL_NAMES.has(tool.name));
}

/**
 * Build one ACP subagent's session options.
 *
 * @param input - The subagent's run input, plus its parsed ACP model and derived profile
 * @param createTranscriptStore - Supplies the session's transcript store; a subagent gets its own
 */
export async function acpSubagentSessionOptions(
  input: AcpSubagentSessionInput,
  createTranscriptStore: () => TranscriptStore,
): Promise<CreateAgentSessionOptions> {
  const { acp } = input;
  const resolved = await _acpSubagentDeps.chatAcpTools(deliveredProviders(input), input.cwd);
  return {
    backend: _acpSubagentDeps.acpBackend({
      agent: acp.agent,
      allowUnsandboxed: true,
      inheritEnv: true,
      ...(acp.model !== undefined ? { model: acp.model } : {}),
      ...(acp.effort !== undefined ? { effort: acp.effort } : {}),
    }),
    profile: input.profile,
    workdir: input.cwd,
    tools: subagentTools(resolved.tools, input.profile),
    instructions: buildAcpSubagentInstructions({
      agentLabel: acpAgentLabel(acp.agent),
      agent: input.agent,
      ...(resolved.instructions !== undefined ? { toolInstructions: resolved.instructions } : {}),
      ...(input.memoryIndex !== undefined ? { memoryIndex: input.memoryIndex } : {}),
    }),
    transcriptStore: createTranscriptStore(),
    metadata: { parentSessionId: input.parentSessionId, subagent: input.agent.qualifiedName },
    approvalTimeoutMs: input.config.execution.approvalTimeout,
  };
}
