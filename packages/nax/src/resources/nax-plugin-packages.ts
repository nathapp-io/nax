import { dirname } from "node:path";
import type { PluginResourceDirs } from "../plugins/types";
import { scanAgentsDir, scanCommandsDir, scanSkillsDir } from "./scan-dirs";
import type { ResourceOrigin, ResourcePackage } from "./types";

async function scanPlugin(dirs: PluginResourceDirs): Promise<ResourcePackage> {
  const origin: ResourceOrigin = { kind: "nax-plugin", plugin: dirs.plugin };
  const empty = { resources: [], diagnostics: [] };
  const [skills, commands, agents] = await Promise.all([
    dirs.skills === undefined ? empty : scanSkillsDir(dirs.skills, origin),
    dirs.commands === undefined ? empty : scanCommandsDir(dirs.commands, origin),
    dirs.agents === undefined ? empty : scanAgentsDir(dirs.agents, origin),
  ]);
  const firstDir = dirs.skills ?? dirs.commands ?? dirs.agents;
  return {
    id: `nax:${dirs.plugin}`,
    origin,
    // The registry exposes component directories, not the module path. Use the
    // first declared directory's parent; an empty provider has no known root.
    root: firstDir === undefined ? "" : dirname(firstDir),
    skills: skills.resources,
    commands: commands.resources,
    agents: agents.resources,
    mcpServers: [],
    hooks: [],
    diagnostics: [...skills.diagnostics, ...commands.diagnostics, ...agents.diagnostics],
  };
}

/** Scan data-only plugin directories without importing or executing resource files. */
export function naxPluginPackages(dirs: readonly PluginResourceDirs[]): Promise<ResourcePackage[]> {
  return Promise.all(dirs.map(scanPlugin));
}
