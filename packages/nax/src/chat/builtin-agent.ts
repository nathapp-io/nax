/**
 * The built-in general agent (chat-dispatch-visibility US-001).
 *
 * A `nax-agents__run` call that names a model and no agent has no agent file to run
 * on, and picking a carrier from the catalog made the caller guess. It runs on this
 * agent instead. It is deliberately never a `ResourceCatalog` entry: `/agents`, the
 * agents index and `findAgent` stay blind to it, so naming an agent still means
 * naming a discovered one.
 */
import { buildGeneralAgentPrompt } from "@/prompts";
import type { AgentResource } from "@/resources";

export const GENERAL_AGENT_NAME = "general";
export const GENERAL_AGENT_DESCRIPTION = "Runs a self-contained task on the model you pass";

/**
 * The agent a nax-agents__run call with a model and no agent runs on.
 *
 * No `model`: the caller's model is the whole point. No `tools`: with none declared,
 * a native run admits every parent tool and an ACP run gets the chat profile.
 */
export function generalAgent(): AgentResource {
  return {
    kind: "agent",
    name: GENERAL_AGENT_NAME,
    qualifiedName: GENERAL_AGENT_NAME,
    description: GENERAL_AGENT_DESCRIPTION,
    prompt: buildGeneralAgentPrompt(),
    path: "",
    origin: { kind: "nax-builtin" },
  };
}
