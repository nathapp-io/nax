/**
 * The chat session's tool providers, composed in one place.
 *
 * Always last: the `nax-agents` provider, which is offered even when the catalog has no
 * agent of its own — the built-in general and explore agents are reachable regardless. It
 * is also the only provider that can start a run in the background, so it is the one place
 * the host hands its background registry across.
 */
import type { ToolProvider } from "@nathapp/nax-agent";
import type { ResourceCatalog } from "@/resources";
import { createAgentsProvider } from "./agents-provider";
import type { SubagentRuns } from "./subagent-runs";

export interface ChatToolProvidersInput {
  readonly catalog: ResourceCatalog;
  /** The resources' and the jobs' providers, in the order the session offers them. */
  readonly providers: readonly ToolProvider[];
  /** The chat's nested runs: the provider starts both foreground and background ones. */
  readonly runs: SubagentRuns;
}

/** The provider list one chat session opens with. */
export function chatToolProviders(input: ChatToolProvidersInput): readonly ToolProvider[] {
  const { catalog, providers, runs } = input;
  const agents = createAgentsProvider({ catalog, run: runs.run, runInBackground: runs.runInBackground });
  return [...providers, agents];
}
