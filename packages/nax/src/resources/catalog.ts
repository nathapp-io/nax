import type { NaxConfig } from "../config";
import { claudeConfigDir, claudeJsonPath, naxAgentsDir } from "./claude-paths";
import { discoverClaudeCodePackages } from "./claude-sources";
import { scanAgentsDir } from "./scan-dirs";
import type {
  AgentResource,
  CommandResource,
  ResourceCatalog,
  ResourceDiagnostic,
  ResourcePackage,
  SkillResource,
} from "./types";

/** Index both names without allowing a later package to replace either winner. */
function indexResources<T extends SkillResource | CommandResource | AgentResource>(
  packages: readonly ResourcePackage[],
  select: (pkg: ResourcePackage) => readonly T[],
  diagnostics: ResourceDiagnostic[],
): Map<string, T> {
  const index = new Map<string, T>();
  const winners = new Map<string, string>();
  for (const pkg of packages) {
    for (const resource of select(pkg)) {
      const winner = winners.get(resource.name);
      if (winner !== undefined) {
        diagnostics.push({
          severity: "warn",
          path: resource.path,
          origin: resource.origin,
          message: `${resource.kind} ${resource.name} from ${pkg.id} is shadowed by ${winner}; use ${resource.qualifiedName}`,
        });
      } else {
        winners.set(resource.name, pkg.id);
        index.set(resource.name, resource);
      }
      if (!index.has(resource.qualifiedName)) index.set(resource.qualifiedName, resource);
    }
  }
  return index;
}

/** Preserve all loaded resources; package order decides short and qualified lookup precedence. */
export function buildResourceCatalog(packages: readonly ResourcePackage[]): ResourceCatalog {
  const ordered = [...packages];
  const diagnostics = ordered.flatMap((pkg) => pkg.diagnostics);
  const skills = indexResources(ordered, (pkg) => pkg.skills, diagnostics);
  const commands = indexResources(ordered, (pkg) => pkg.commands, diagnostics);
  const agents = indexResources(ordered, (pkg) => pkg.agents, diagnostics);
  return {
    packages: ordered,
    skills: ordered.flatMap((pkg) => pkg.skills),
    commands: ordered.flatMap((pkg) => pkg.commands),
    agents: ordered.flatMap((pkg) => pkg.agents),
    diagnostics,
    findSkill: (name) => skills.get(name),
    findCommand: (name) => commands.get(name),
    findAgent: (name) => agents.get(name),
  };
}

/**
 * nax's own user agents, `nax-user`. An absent directory yields no package and no
 * diagnostic, so a host that never made one does not see an empty package.
 */
async function naxUserPackage(env: Readonly<Record<string, string | undefined>>): Promise<ResourcePackage | undefined> {
  const origin = { kind: "nax-user" } as const;
  const root = naxAgentsDir(env);
  const { resources, diagnostics } = await scanAgentsDir(root, origin);
  if (resources.length === 0 && diagnostics.length === 0) return undefined;
  return {
    id: "nax-user",
    root,
    origin,
    skills: [],
    commands: [],
    agents: resources,
    mcpServers: [],
    hooks: [],
    diagnostics,
  };
}

/**
 * Place `nax-user` between the repo's package and the user/plugin packages, so a repo
 * agent wins a name clash over a `~/.nax` agent, which wins over a plugin agent.
 */
function withNaxUser(
  packages: readonly ResourcePackage[],
  naxUser: ResourcePackage | undefined,
): readonly ResourcePackage[] {
  if (naxUser === undefined) return packages;
  const at = packages[0]?.origin.kind === "claude-project" ? 1 : 0;
  return [...packages.slice(0, at), naxUser, ...packages.slice(at)];
}

/** Repo-scoped discovery; callers settle trust before loading any resources. */
export async function loadResourceCatalog(options: {
  repoRoot: string;
  config: Pick<NaxConfig, "resources">;
  env: Readonly<Record<string, string | undefined>>;
  naxPluginPackages: readonly ResourcePackage[];
}): Promise<ResourceCatalog> {
  const { repoRoot, config, env, naxPluginPackages } = options;
  const [claudePackages, naxUser] = await Promise.all([
    (config.resources?.claudeCode ?? true)
      ? discoverClaudeCodePackages({ repoRoot, claudeDir: claudeConfigDir(env), claudeJson: claudeJsonPath(env) })
      : Promise.resolve<ResourcePackage[]>([]),
    // nax's own agents are not Claude Code resources: they load with discovery disabled too.
    naxUserPackage(env),
  ]);
  return buildResourceCatalog([...withNaxUser(claudePackages, naxUser), ...naxPluginPackages]);
}
