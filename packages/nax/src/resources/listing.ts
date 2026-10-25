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

/** Discovery failures live on base packages when no plugin package could be created. */
function discoveryDiagnostics(catalog: ResourceCatalog): readonly ResourceDiagnostic[] {
  const baseDiagnostics = new Set(
    catalog.packages
      .filter((pkg) => pkg.origin.kind === "claude-project" || pkg.origin.kind === "claude-user")
      .flatMap((pkg) => pkg.diagnostics),
  );
  return catalog.diagnostics.filter(
    (entry) =>
      baseDiagnostics.has(entry) &&
      (entry.origin.kind === "claude-plugin" ||
        ["settings.json", "installed_plugins.json"].includes(basename(entry.path))),
  );
}

/** Includes shadowed skills, malformed skills and discovery failures, in catalog order. */
export function formatSkillsListing(catalog: ResourceCatalog): string {
  const discovery = new Set(discoveryDiagnostics(catalog));
  return [
    ...catalog.skills.map((skill) => `${skill.qualifiedName}  ${originLabel(skill.origin)}  ${skill.path}`),
    ...catalog.diagnostics
      .filter((entry) => basename(entry.path) === "SKILL.md" || discovery.has(entry))
      .map(diagnosticLine),
  ].join("\n");
}

function packageLines(pkg: ResourcePackage): string[] {
  return [
    `${pkg.id}  skills ${pkg.skills.length}, commands ${pkg.commands.length}, agents ${pkg.agents.length} (not delivered yet), mcp ${pkg.mcpServers.length}, hooks ${pkg.hooks.length} (not executed)`,
    ...pkg.diagnostics.map(diagnosticLine),
  ];
}

/** Deferred capabilities are visible, but are never delivered or executed here. */
export function formatPluginsListing(
  catalog: ResourceCatalog,
  naxPlugins: readonly Pick<NaxPlugin, "name" | "provides">[],
): string {
  const claude = catalog.packages.filter((pkg) => pkg.origin.kind === "claude-plugin").flatMap(packageLines);
  const printed = new Set(claude);
  claude.push(
    ...discoveryDiagnostics(catalog)
      .map(diagnosticLine)
      .filter((line) => !printed.has(line)),
  );
  const nax = naxPlugins.map((plugin) => `${plugin.name}  ${plugin.provides.join(", ")}`);
  return [
    "Claude Code plugins",
    ...(claude.length ? claude : ["(none)"]),
    "",
    "nax plugins",
    ...(nax.length ? nax : ["(none)"]),
  ].join("\n");
}
