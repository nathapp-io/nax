import { basename } from "node:path";
import type { NaxPlugin } from "@/plugins";
import type { ResourceCatalog, ResourceDiagnostic, ResourceOrigin, ResourcePackage } from "./types";

function originLabel(origin: ResourceOrigin): string {
  switch (origin.kind) {
    case "claude-project":
      return "project";
    case "claude-user":
      return "user";
    case "claude-plugin":
      return `plugin ${origin.plugin}`;
    case "nax-plugin":
      return `nax-plugin ${origin.plugin}`;
  }
}

function diagnosticLine(diagnostic: ResourceDiagnostic): string {
  return `${diagnostic.severity}  ${diagnostic.path}  ${diagnostic.message}`;
}

/** Includes shadowed skills and malformed skill diagnostics, in catalog order. */
export function formatSkillsListing(catalog: ResourceCatalog): string {
  return [
    ...catalog.skills.map((skill) => `${skill.qualifiedName}  ${originLabel(skill.origin)}  ${skill.path}`),
    ...catalog.diagnostics.filter((entry) => basename(entry.path) === "SKILL.md").map(diagnosticLine),
  ].join("\n");
}

function packageLines(pkg: ResourcePackage): string[] {
  return [
    `${pkg.id}  skills ${pkg.skills.length}, commands ${pkg.commands.length}, agents ${pkg.agents.length} (not delivered yet), mcp ${pkg.mcpServers.length} (not delivered yet), hooks ${pkg.hooks.length} (not executed)`,
    ...pkg.diagnostics.map(diagnosticLine),
  ];
}

/** Deferred capabilities are visible, but are never delivered or executed here. */
export function formatPluginsListing(
  catalog: ResourceCatalog,
  naxPlugins: readonly Pick<NaxPlugin, "name" | "provides">[],
): string {
  const claude = catalog.packages.filter((pkg) => pkg.origin.kind === "claude-plugin").flatMap(packageLines);
  const nax = naxPlugins.map((plugin) => `${plugin.name}  ${plugin.provides.join(", ")}`);
  return [
    "Claude Code plugins",
    ...(claude.length ? claude : ["(none)"]),
    "",
    "nax plugins",
    ...(nax.length ? nax : ["(none)"]),
  ].join("\n");
}
