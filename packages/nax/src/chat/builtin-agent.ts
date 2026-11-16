/**
 * The built-in chat agents: `general` (chat-dispatch-visibility US-001) and `explore`
 * (chat-polish-and-branch-guard US-003).
 *
 * A `nax-agents__run` call with no agent has no agent file to run on, and picking a
 * carrier from the catalog made the caller guess. It runs on the general agent instead,
 * on the chat's model unless the call passes one. Neither agent is ever a
 * `ResourceCatalog` entry: `/agents`, the agents index and `findAgent` stay blind to
 * them, so naming an agent still means naming a discovered one — `agentNamed` reaches
 * them for the names the tool description advertises.
 */
import { buildExploreAgentPrompt, buildGeneralAgentPrompt } from "@/prompts";
import type { AgentResource, ResourceCatalog } from "@/resources";

export const GENERAL_AGENT_NAME = "general";
export const GENERAL_AGENT_DESCRIPTION =
  "Runs a self-contained task with your tools, on your model unless you pass one";

export const EXPLORE_AGENT_NAME = "explore";
export const EXPLORE_AGENT_DESCRIPTION = "Searches and reads the codebase without changing it";

/** The read-only tools the explore agent is admitted to: no write, no edit, no shell. */
const EXPLORE_AGENT_TOOLS = ["Read", "Glob", "Grep", "Git"] as const;

/** The catalog's agent for that name, else the built-in of the same name when there is one. */
function builtinNamed(name: string): AgentResource | undefined {
  if (name === GENERAL_AGENT_NAME) return generalAgent();
  if (name === EXPLORE_AGENT_NAME) return exploreAgent();
  return undefined;
}

/**
 * The agent a `nax-agents__run` name resolves to: the catalog's agent for that name, or
 * the built-in `general`/`explore` agent when the catalog has none.
 *
 * A discovered agent always wins, so a project that ships its own `general` or `explore`
 * agent keeps it.
 */
export function agentNamed(catalog: Pick<ResourceCatalog, "findAgent">, name: string): AgentResource | undefined {
  return catalog.findAgent(name) ?? builtinNamed(name);
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

/**
 * The read-only search agent: it finds and reads code and reports where it is, and it
 * declares the only tools that can do that without changing anything.
 *
 * No `model`: it runs on the caller's model unless the call passes one.
 */
export function exploreAgent(): AgentResource {
  return {
    kind: "agent",
    name: EXPLORE_AGENT_NAME,
    qualifiedName: EXPLORE_AGENT_NAME,
    description: EXPLORE_AGENT_DESCRIPTION,
    tools: EXPLORE_AGENT_TOOLS,
    prompt: buildExploreAgentPrompt(),
    path: "",
    origin: { kind: "nax-builtin" },
  };
}
