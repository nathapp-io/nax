import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { readClaudeJsonMcp } from "./claude-json";
import { type HookParseResult, hooksFromSettings, parseHooksJson } from "./parse-hooks";
import { parseMcpJson } from "./parse-mcp";
import { isResourceObject, readResourceJson, resourceError } from "./parse-shared";
import { _resourceFsDeps, scanAgentsDir, scanCommandsDir, scanSkillsDir } from "./scan-dirs";
import type { ResourceDiagnostic, ResourceOrigin, ResourcePackage } from "./types";

type DiagnosticSink = ResourceDiagnostic[];
type JsonObject = Record<string, unknown>;
const USER_ORIGIN = { kind: "claude-user" } as const;
const PROJECT_ORIGIN = { kind: "claude-project" } as const;
const INSTALLED_PLUGINS_VERSION = 2;

function missing(error: unknown): boolean {
  return isResourceObject(error) && error.code === "ENOENT";
}

async function optionalText(options: {
  path: string;
  origin: ResourceOrigin;
  diagnostics: DiagnosticSink;
}): Promise<string | undefined> {
  const { path, origin, diagnostics } = options;
  try {
    return await _resourceFsDeps.readFile(path);
  } catch (error) {
    if (!missing(error))
      diagnostics.push(resourceError(path, origin, `Cannot read ${path}: ${errorMessage(error)}`).diagnostic);
    return undefined;
  }
}

async function optionalObject(options: {
  path: string;
  origin: ResourceOrigin;
  diagnostics: DiagnosticSink;
}): Promise<JsonObject | undefined> {
  const text = await optionalText(options);
  if (text === undefined) return undefined;
  const parsed = readResourceJson(options.path, text, options.origin);
  if ("diagnostic" in parsed) options.diagnostics.push(parsed.diagnostic);
  else if (isResourceObject(parsed.data)) return parsed.data;
  else
    options.diagnostics.push(
      resourceError(options.path, options.origin, `Expected JSON object in ${options.path}`).diagnostic,
    );
  return undefined;
}

async function scanPackage(options: {
  id: string;
  root: string;
  componentRoot: string;
  origin: ResourceOrigin;
  settings?: JsonObject;
  settingsPath?: string;
  plugin?: boolean;
  diagnostics: DiagnosticSink;
}): Promise<ResourcePackage> {
  const { id, root, componentRoot, origin, diagnostics } = options;
  const [skills, commands, agents] = await Promise.all([
    scanSkillsDir(join(componentRoot, "skills"), origin),
    scanCommandsDir(join(componentRoot, "commands"), origin),
    scanAgentsDir(join(componentRoot, "agents"), origin),
  ]);
  diagnostics.push(...skills.diagnostics, ...commands.diagnostics, ...agents.diagnostics);
  const mcpPath = join(root, ".mcp.json");
  const mcpText =
    origin.kind === "claude-user" ? undefined : await optionalText({ path: mcpPath, origin, diagnostics });
  const mcpScope = options.plugin ? "plugin" : "project";
  const mcp =
    mcpText === undefined ? { resources: [], diagnostics: [] } : parseMcpJson(mcpPath, mcpText, origin, mcpScope);
  diagnostics.push(...mcp.diagnostics);
  const hooksPath = options.settingsPath ?? join(root, "hooks/hooks.json");
  const hooksText = options.plugin ? await optionalText({ path: hooksPath, origin, diagnostics }) : undefined;
  const hooks: HookParseResult = options.plugin
    ? hooksText === undefined
      ? {}
      : parseHooksJson(hooksPath, hooksText, origin)
    : options.settings === undefined
      ? {}
      : hooksFromSettings(hooksPath, options.settings, origin);
  if ("diagnostic" in hooks && hooks.diagnostic) diagnostics.push(hooks.diagnostic);
  return {
    id,
    root,
    origin,
    skills: skills.resources,
    commands: commands.resources,
    agents: agents.resources,
    mcpServers: mcp.resources,
    hooks: "resource" in hooks && hooks.resource ? [hooks.resource] : [],
    diagnostics,
  };
}

async function installedPlugins(claudeDir: string, diagnostics: DiagnosticSink): Promise<JsonObject | undefined> {
  const path = join(claudeDir, "plugins/installed_plugins.json");
  const count = diagnostics.length;
  const data = await optionalObject({ path, origin: USER_ORIGIN, diagnostics });
  if (!data) {
    if (diagnostics.length === count)
      diagnostics.push({
        severity: "warn",
        path,
        origin: USER_ORIGIN,
        message: `[resources] Missing installed_plugins.json at ${path}`,
      });
    return undefined;
  }
  if (data.version !== INSTALLED_PLUGINS_VERSION || !isResourceObject(data.plugins)) {
    diagnostics.push(
      resourceError(path, USER_ORIGIN, `Expected installed_plugins.json version 2 with plugins object in ${path}`)
        .diagnostic,
    );
    return undefined;
  }
  return data.plugins;
}

function installRecord(records: unknown, repoRoot: string): JsonObject | undefined {
  if (!Array.isArray(records)) return undefined;
  const objects = records.filter(isResourceObject);
  return (
    objects.find((record) => record.scope === "user") ??
    objects.find((record) => record.scope === "project" && record.projectPath === repoRoot)
  );
}

async function usableInstallPath(options: {
  key: string;
  root: string;
  origin: ResourceOrigin;
  diagnostics: DiagnosticSink;
}): Promise<boolean> {
  const { key, root, origin, diagnostics } = options;
  try {
    if (await _resourceFsDeps.isDirectory(root)) return true;
    diagnostics.push({
      severity: "warn",
      path: root,
      origin,
      message: `[resources] plugin ${key} installPath is not a directory: ${root}`,
    });
  } catch (error) {
    diagnostics.push({
      severity: "warn",
      path: root,
      origin,
      message: `[resources] Cannot access plugin ${key} installPath ${root}: ${errorMessage(error)}`,
    });
  }
  return false;
}

async function pluginPackage(options: {
  key: string;
  records: unknown;
  repoRoot: string;
  registryPath: string;
  diagnostics: DiagnosticSink;
}): Promise<ResourcePackage | undefined> {
  const { key, repoRoot, registryPath, diagnostics } = options;
  const separator = key.lastIndexOf("@");
  const origin: ResourceOrigin = {
    kind: "claude-plugin",
    plugin: separator < 0 ? key : key.slice(0, separator),
    marketplace: separator < 0 ? "" : key.slice(separator + 1),
  };
  const record = installRecord(options.records, repoRoot);
  if (!record || typeof record.installPath !== "string" || !record.installPath) {
    diagnostics.push({
      severity: "warn",
      path: registryPath,
      origin,
      message: `[resources] plugin ${key} is enabled but not installed`,
    });
    return undefined;
  }
  const root = record.installPath;
  if (!(await usableInstallPath({ key, root, origin, diagnostics }))) return undefined;
  const pluginDiagnostics: DiagnosticSink = [];
  const manifest = await optionalObject({
    path: join(root, ".claude-plugin/plugin.json"),
    origin,
    diagnostics: pluginDiagnostics,
  });
  const namedOrigin = {
    ...origin,
    plugin: typeof manifest?.name === "string" && manifest.name ? manifest.name : origin.plugin,
  };
  return scanPackage({
    id: key,
    root,
    componentRoot: root,
    origin: namedOrigin,
    plugin: true,
    diagnostics: pluginDiagnostics,
  });
}

function enabledEntries(settings: JsonObject | undefined): JsonObject {
  return isResourceObject(settings?.enabledPlugins) ? settings.enabledPlugins : {};
}

async function basePackage(root: string, origin: typeof PROJECT_ORIGIN | typeof USER_ORIGIN) {
  const diagnostics: DiagnosticSink = [];
  const componentRoot = origin.kind === "claude-project" ? join(root, ".claude") : root;
  const settingsPath = join(componentRoot, "settings.json");
  const settings = await optionalObject({ path: settingsPath, origin, diagnostics });
  const pkg = await scanPackage({ id: origin.kind, root, componentRoot, origin, settings, settingsPath, diagnostics });
  return { pkg, settings, diagnostics };
}

/** Repo-scoped project resources, user resources and enabled plugins, in precedence order. */
export async function discoverClaudeCodePackages(options: {
  repoRoot: string;
  claudeDir: string;
  claudeJson: string;
}): Promise<ResourcePackage[]> {
  const { repoRoot, claudeDir, claudeJson } = options;
  const [project, user, json] = await Promise.all([
    basePackage(repoRoot, PROJECT_ORIGIN),
    basePackage(claudeDir, USER_ORIGIN),
    readClaudeJsonMcp(claudeJson, repoRoot),
  ]);
  user.diagnostics.push(...json.userDiagnostics);
  project.diagnostics.push(...json.projectDiagnostics);
  const packages: ResourcePackage[] = [
    { ...project.pkg, mcpServers: [...json.local, ...project.pkg.mcpServers] },
    { ...user.pkg, mcpServers: [...user.pkg.mcpServers, ...json.user] },
  ];
  const userDiagnostics = user.diagnostics;
  const enabled = Object.entries({ ...enabledEntries(user.settings), ...enabledEntries(project.settings) })
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  if (!enabled.length) return packages;
  // Skipped plugins have no package; retain their origin-bearing diagnostics on the user package.
  const plugins = await installedPlugins(claudeDir, userDiagnostics);
  if (!plugins) return packages;
  for (const key of enabled) {
    const pkg = await pluginPackage({
      key,
      records: Object.hasOwn(plugins, key) ? plugins[key] : undefined,
      repoRoot,
      registryPath: join(claudeDir, "plugins/installed_plugins.json"),
      diagnostics: userDiagnostics,
    });
    if (pkg) packages.push(pkg);
  }
  return packages;
}
