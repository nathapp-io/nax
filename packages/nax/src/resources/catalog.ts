import type { NaxConfig } from "../config";
import { claudeConfigDir } from "./claude-paths";
import { discoverClaudeCodePackages } from "./claude-sources";
import type { CommandResource, ResourceCatalog, ResourceDiagnostic, ResourcePackage, SkillResource } from "./types";

/** Index both names without allowing a later package to replace either winner. */
function indexResources<T extends SkillResource | CommandResource>(
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
  return {
    packages: ordered,
    skills: ordered.flatMap((pkg) => pkg.skills),
    commands: ordered.flatMap((pkg) => pkg.commands),
    diagnostics,
    findSkill: (name) => skills.get(name),
    findCommand: (name) => commands.get(name),
  };
}

/** Repo-scoped discovery; callers settle trust before loading any resources. */
export async function loadResourceCatalog(options: {
  repoRoot: string;
  config: Pick<NaxConfig, "resources">;
  env: Readonly<Record<string, string | undefined>>;
  naxPluginPackages: readonly ResourcePackage[];
}): Promise<ResourceCatalog> {
  const { repoRoot, config, env, naxPluginPackages } = options;
  const packages =
    (config.resources?.claudeCode ?? true)
      ? await discoverClaudeCodePackages({ repoRoot, claudeDir: claudeConfigDir(env) })
      : [];
  return buildResourceCatalog([...packages, ...naxPluginPackages]);
}
