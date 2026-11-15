/**
 * The built-in general agent (chat-dispatch-visibility US-001).
 *
 * A `nax-agents__run` call with no agent has no agent file to run on, and picking a
 * carrier from the catalog made the caller guess. It runs on this agent instead, on the
 * chat's model unless the call passes one. It is deliberately never a `ResourceCatalog`
 * entry: `/agents`, the agents index and `findAgent` stay blind to it, so naming an
 * agent still means naming a discovered one — `agentNamed` reaches it for the one name
 * the tool description advertises.
 */
import { buildGeneralAgentPrompt } from "@/prompts";
import type { AgentResource, ResourceCatalog } from "@/resources";

export const GENERAL_AGENT_NAME = "general";
export const GENERAL_AGENT_DESCRIPTION =
  "Runs a self-contained task with your tools, on your model unless you pass one";

/**
 * The agent a `nax-agents__run` name resolves to: the catalog's agent for that name, or
 * the built-in general agent when the name is `general` and the catalog has none.
 *
 * A discovered agent always wins, so a project that ships its own `general` agent keeps it.
 */
export function agentNamed(catalog: Pick<ResourceCatalog, "findAgent">, name: string): AgentResource | undefined {
  return catalog.findAgent(name) ?? (name === GENERAL_AGENT_NAME ? generalAgent() : undefined);
}

/**
 * The agent a run with no agent name runs on: the built-in general agent, never a
 * catalog lookup.
 *
 * No `model`: the caller's model is what runs unless the call passes one. No `tools`:
 * with none declared, a native run admits every parent tool and an ACP run gets the
 * chat profile.
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
