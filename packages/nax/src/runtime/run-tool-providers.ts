import type { ToolProvider } from "@nathapp/nax-agent";
import type { NaxConfig } from "../config";
import { createSkillsProvider, type ResourceCatalog } from "../resources";

/** Preserve MCP providers by default; append lazily loaded skills only on opt-in. */
export function withRunSkills(
  providers: readonly ToolProvider[],
  config: NaxConfig,
  load: () => Promise<ResourceCatalog>,
): readonly ToolProvider[] {
  return (config.resources?.skillsInRun ?? false) ? [...providers, createSkillsProvider(load)] : providers;
}
