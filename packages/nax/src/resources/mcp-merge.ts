/**
 * Merge catalog MCP resources into one ordinary `McpConfig`, so a single MCP
 * client serves both configured and discovered servers. `mergeCatalogMcpServers`
 * is pure: no I/O, no logging; every dropped or shadowed entry is reported as a
 * `ResourceDiagnostic`. `resolveCatalogMcpConfig` is the adapter around it that
 * loads the catalog and logs those diagnostics.
 */
import { MCP_DEFAULT_TIMEOUT_MS, type McpConfig, type McpServerConfig, type NaxConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import { type McpLockFile, resolveMcpLock } from "@/mcp";
import type { loadResourceCatalog } from "./catalog";
import { expandMcpValue, mcpServerId } from "./mcp-expand";
import type { McpServerResource, McpServerScope, ResourceCatalog, ResourceDiagnostic, ResourcePackage } from "./types";

export type McpServerSource = "config" | McpServerScope;

export interface MergedMcpServers {
  readonly config: McpConfig;
  /** Server id -> where the entry came from; plugin entries also carry the plugin name. */
  readonly sources: ReadonlyMap<string, { readonly source: McpServerSource; readonly plugin?: string }>;
  readonly diagnostics: readonly ResourceDiagnostic[];
}

type Env = Readonly<Record<string, string | undefined>>;
type Source = { readonly source: McpServerSource; readonly plugin?: string };
type Built = { readonly server: McpServerConfig } | { readonly missing: string };

/** Plugin name for entries that belong to a plugin package, whatever kind of plugin. */
function pluginName(entry: McpServerResource): string | undefined {
  const { origin } = entry;
  return origin.kind === "claude-plugin" || origin.kind === "nax-plugin" ? origin.plugin : undefined;
}

function sourceOf(entry: McpServerResource): Source {
  const plugin = entry.scope === "plugin" ? pluginName(entry) : undefined;
  return plugin === undefined ? { source: entry.scope } : { source: "plugin", plugin };
}

function describeSource(source: Source): string {
  return source.source === "plugin" && source.plugin !== undefined ? `plugin ${source.plugin}` : source.source;
}

/** Expand every string in `values`, stopping at the first unset variable. */
function expandAll(values: readonly string[], vars: Env): { readonly values: string[] } | { readonly missing: string } {
  const out: string[] = [];
  for (const value of values) {
    const expanded = expandMcpValue(value, vars);
    if ("missing" in expanded) return { missing: expanded.missing };
    out.push(expanded.value);
  }
  return { values: out };
}

/** Expand a record's values (never its keys), stopping at the first unset variable. */
function expandRecord(
  record: Readonly<Record<string, string>>,
  vars: Env,
): { readonly record: Record<string, string> } | { readonly missing: string } {
  const keys = Object.keys(record);
  const expanded = expandAll(
    keys.map((key) => record[key] ?? ""),
    vars,
  );
  if ("missing" in expanded) return expanded;
  return { record: Object.fromEntries(keys.map((key, i) => [key, expanded.values[i] ?? ""])) };
}

function buildStdio(spec: Extract<McpServerResource["server"], { transport: "stdio" }>, vars: Env): Built {
  const command = expandMcpValue(spec.command, vars);
  if ("missing" in command) return command;
  const args = expandAll(spec.args, vars);
  if ("missing" in args) return args;
  const env = expandRecord(spec.env, vars);
  if ("missing" in env) return env;
  return {
    server: {
      command: command.value,
      args: args.values,
      env: env.record,
      headers: {},
      stages: ["*"],
      timeoutMs: MCP_DEFAULT_TIMEOUT_MS,
      enabled: true,
    },
  };
}

function buildHttp(spec: Extract<McpServerResource["server"], { transport: "http" | "sse" }>, vars: Env): Built {
  const url = expandMcpValue(spec.url, vars);
  if ("missing" in url) return url;
  const headers = expandRecord(spec.headers, vars);
  if ("missing" in headers) return headers;
  return {
    server: {
      url: url.value,
      headers: headers.record,
      args: [],
      env: {},
      stages: ["*"],
      timeoutMs: MCP_DEFAULT_TIMEOUT_MS,
      enabled: true,
    },
  };
}

/** `input.env`, plus the package root as `CLAUDE_PLUGIN_ROOT` for a Claude Code plugin entry. */
function varsFor(entry: McpServerResource, pkg: ResourcePackage, env: Env): Env {
  return entry.origin.kind === "claude-plugin" ? { ...env, CLAUDE_PLUGIN_ROOT: pkg.root } : env;
}

/** The id base: the entry name, or `<plugin>-<name>` for a Claude Code plugin entry. */
function baseName(entry: McpServerResource): string {
  return entry.origin.kind === "claude-plugin" ? `${entry.origin.plugin}-${entry.name}` : entry.name;
}

/**
 * Configured `mcp.servers` first (copied unchanged, never expanded), then catalog
 * entries in package order. The first entry to claim an id wins.
 */
export function mergeCatalogMcpServers(input: {
  readonly mcp: McpConfig | undefined;
  readonly catalog: ResourceCatalog;
  readonly env: Env;
}): MergedMcpServers {
  const servers = new Map<string, McpServerConfig>();
  const sources = new Map<string, Source>();
  const diagnostics: ResourceDiagnostic[] = [];

  for (const [id, server] of Object.entries(input.mcp?.servers ?? {})) {
    servers.set(id, server);
    sources.set(id, { source: "config" });
  }

  const drop = (severity: "warn" | "error", entry: McpServerResource, message: string): void => {
    diagnostics.push({ severity, path: entry.path, origin: entry.origin, message: `[resources] ${message}` });
  };

  for (const pkg of input.catalog.packages) {
    for (const entry of pkg.mcpServers) {
      const id = mcpServerId(baseName(entry));
      if (id === "") {
        drop("error", entry, `mcp server name ${entry.name} in ${entry.path} yields no usable id`);
        continue;
      }
      const winner = sources.get(id);
      if (winner !== undefined) {
        drop("warn", entry, `mcp server ${id} from ${entry.path} is shadowed by ${describeSource(winner)}`);
        continue;
      }
      if (entry.server.transport === "sse") {
        drop("warn", entry, `mcp server ${id}: transport sse is not supported`);
        continue;
      }
      const vars = varsFor(entry, pkg, input.env);
      const built = entry.server.transport === "stdio" ? buildStdio(entry.server, vars) : buildHttp(entry.server, vars);
      if ("missing" in built) {
        drop("error", entry, `mcp server ${id}: \${${built.missing}} is not set`);
        continue;
      }
      servers.set(id, built.server);
      sources.set(id, sourceOf(entry));
    }
  }

  return { config: { servers: Object.fromEntries(servers) }, sources, diagnostics };
}

/**
 * The MCP config a consumer should connect: `config.mcp` plus the catalog's servers.
 * Unchanged (and the catalog never loaded) when Claude Code discovery is off.
 * Each merge diagnostic is logged at `warn` under stage `resources`.
 *
 * With `lockedOnly`, a catalog server the MCP lock (project, else global) does not
 * list is dropped: discovered servers are not operator-configured, so an unattended
 * run attaches only the ones `nax mcp lock` has pinned. Configured servers are kept.
 */
export async function resolveCatalogMcpConfig(input: {
  readonly config: NaxConfig;
  readonly repoRoot: string;
  readonly env: Env;
  readonly load: typeof loadResourceCatalog;
  readonly lockedOnly?: boolean;
  readonly readLock?: (projectRoot: string) => Promise<McpLockFile | undefined>;
}): Promise<McpConfig | undefined> {
  const { config, repoRoot, env } = input;
  if (config.resources?.claudeCode === false) return config.mcp;
  const catalog = await input.load({ repoRoot, config, env, naxPluginPackages: [] });
  const merged = mergeCatalogMcpServers({ mcp: config.mcp, catalog, env });
  const logger = getSafeLogger();
  for (const diagnostic of merged.diagnostics) {
    logger?.warn("resources", diagnostic.message, { path: diagnostic.path, origin: diagnostic.origin });
  }
  if (input.lockedOnly !== true) return merged.config;
  const lock = await (input.readLock ?? resolveMcpLock)(repoRoot);
  const kept = Object.entries(merged.config.servers).filter(
    ([id]) => merged.sources.get(id)?.source === "config" || (lock !== undefined && Object.hasOwn(lock.servers, id)),
  );
  return { servers: Object.fromEntries(kept) };
}
