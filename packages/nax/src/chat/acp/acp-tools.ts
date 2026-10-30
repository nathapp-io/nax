/**
 * The tools and tool instructions nax delivers to an ACP chat brain.
 *
 * Of the chat's tool providers only the workflow and jobs providers cross the
 * ACP boundary; the agent keeps its own file, shell, skill and MCP tooling.
 */

import {
  type EmbedderTool,
  renderProviderInstructions,
  resolveProviderTools,
  type ToolProvider,
} from "@nathapp/nax-agent";
import { toEmbedderTools } from "@/agents/acp";

/** Provider ids delivered to an ACP brain. */
export const ACP_CHAT_PROVIDER_IDS: readonly string[] = ["nax-workflow", "nax-jobs"];

const CHAT_STAGE = "chat";

export interface ChatAcpTools {
  readonly tools: readonly EmbedderTool[];
  /** Absent when no delivered provider has anything to say. */
  readonly instructions?: string;
}

/**
 * Resolves the delivered providers for the `chat` stage into embedder tools
 * and rendered instructions. A provider whose `tools()` rejects is dropped.
 */
export async function chatAcpTools(providers: readonly ToolProvider[], workdir: string): Promise<ChatAcpTools> {
  const delivered = providers.filter((provider) => ACP_CHAT_PROVIDER_IDS.includes(provider.id));
  const resolved = await resolveProviderTools(delivered, CHAT_STAGE, workdir);
  const instructions = renderProviderInstructions(resolved.instructions ?? []);
  return {
    tools: toEmbedderTools(resolved.tools, workdir),
    ...(instructions === undefined ? {} : { instructions }),
  };
}
