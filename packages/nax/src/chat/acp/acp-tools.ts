/**
 * The tools and tool instructions nax delivers to an ACP session.
 *
 * Which providers cross this boundary is an allow-list the caller supplies:
 * the chat brain gets the workflow, jobs and memory providers and keeps its own
 * file, shell, skill and MCP tooling, while an unattended subagent may also be
 * handed the skills provider (see `acp-subagent-session.ts`).
 */

import {
  type EmbedderTool,
  renderProviderInstructions,
  resolveProviderTools,
  type ToolProvider,
} from "@nathapp/nax-agent";
import { toEmbedderTools } from "@/agents/acp";

/** Provider ids delivered to an ACP chat brain. */
export const ACP_CHAT_PROVIDER_IDS: readonly string[] = ["nax-workflow", "nax-jobs", "nax-memory"];

const CHAT_STAGE = "chat";

export interface ChatAcpTools {
  readonly tools: readonly EmbedderTool[];
  /** Absent when no delivered provider has anything to say. */
  readonly instructions?: string;
}

export interface ChatAcpToolsOptions {
  /**
   * The provider ids that may resolve into tools. Defaults to the chat's own
   * list; a caller with a different boundary (an unattended subagent, whose
   * allow-list also carries the skills provider) passes its own.
   */
  readonly providerIds?: readonly string[];
}

/**
 * Resolves the delivered providers for the `chat` stage into embedder tools
 * and rendered instructions. A provider whose `tools()` rejects is dropped.
 */
export async function chatAcpTools(
  providers: readonly ToolProvider[],
  workdir: string,
  options: ChatAcpToolsOptions = {},
): Promise<ChatAcpTools> {
  const allowed = options.providerIds ?? ACP_CHAT_PROVIDER_IDS;
  const delivered = providers.filter((provider) => allowed.includes(provider.id));
  const resolved = await resolveProviderTools(delivered, CHAT_STAGE, workdir);
  const instructions = renderProviderInstructions(resolved.instructions ?? []);
  return {
    tools: toEmbedderTools(resolved.tools, workdir),
    ...(instructions === undefined ? {} : { instructions }),
  };
}
