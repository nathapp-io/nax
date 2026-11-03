import type { ToolProvider } from "@nathapp/nax-agent";
import type { NaxConfig } from "../config";
import type { RunMemory } from "../memory";
import { createSkillsProvider, type ResourceCatalog } from "../resources";

/** Preserve MCP providers by default; append lazily loaded skills only on opt-in. */
export function withRunSkills(
  providers: readonly ToolProvider[],
  config: NaxConfig,
  load: () => Promise<ResourceCatalog>,
): readonly ToolProvider[] {
  return (config.resources?.skillsInRun ?? false) ? [...providers, createSkillsProvider(load)] : providers;
}

/**
 * Append the run memory's provider after every provider already advertised.
 *
 * Last, so an existing provider's tools are namespaced before the memory's and the
 * list a run without memory hands out is the very array `withRunSkills` returned.
 */
export function withRunMemory(
  providers: readonly ToolProvider[],
  memory: RunMemory | undefined,
): readonly ToolProvider[] {
  return memory ? [...providers, memory.provider] : providers;
}
