/**
 * `nax mcp lock` — refresh `.nax/mcp-lock.json` from what each configured
 * (or Claude-Code-discovered) server advertises right now. `--global` writes `<globalDir>/mcp-lock.json`
 * instead, for servers configured once in `~/.nax/config.json` (US-002).
 *
 * Connects every enabled server ONCE, at the project root. That is deliberate:
 * the lock pins a server's capability surface, which does not vary per worktree,
 * even though connections at runtime do (spec R7).
 */
import { loadConfig, type McpServerConfig } from "@/config";
// The BARREL, not `@/mcp/pool` — `check:alias-internals` forbids a value import
// of `@/<dir>/<internal>` from `src/` once `src/<dir>/index.ts` exists.
import {
  carryReadOnlyGrants,
  createMcpPool,
  globalMcpLockPath,
  mcpLockPath,
  readMcpLockAt,
  redactMcpUrl,
  schemaHash,
  writeMcpLockAt,
} from "@/mcp";
import { loadResourceCatalog, resolveCatalogMcpConfig } from "@/resources";

/** Injectable seams: tests point `env` at an empty Claude config dir and stub the catalog and pool. */
export const _mcpLockCommandDeps = {
  loadConfig,
  loadResourceCatalog,
  createMcpPool,
  env: process.env as Readonly<Record<string, string | undefined>>,
};

function sortedNames(names: string[]): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** What to tell the operator to check: the url of an HTTP server, the command of a stdio one. */
function serverTarget(server: McpServerConfig | undefined): string {
  if (server?.url !== undefined) return redactMcpUrl(server.url);
  return server?.command ?? "(unconfigured)";
}

// `loadConfig(startDir)` — NOT `loadConfigForWorkdir`, whose first argument is a
// config FILE path (src/config/loader.ts:403), not a directory. Every other CLI
// command loads this way (src/cli/setup.ts:31, src/cli/generate.ts:56).
export async function runMcpLockCommand(
  workdir: string,
  opts?: { global?: boolean; retry?: { maxAttempts: number; baseDelayMs: number } },
): Promise<void> {
  const deps = _mcpLockCommandDeps;
  const config = await deps.loadConfig(workdir);
  // Configured servers plus every Claude Code catalog server (unless resources.claudeCode
  // is off), so a catalog server is pinned beside the configured ones.
  const mcp = await resolveCatalogMcpConfig({
    config,
    repoRoot: workdir,
    env: deps.env,
    load: deps.loadResourceCatalog,
  });
  const servers = mcp?.servers ?? {};
  const enabled = Object.entries(servers).filter(([, server]) => server.enabled);
  if (enabled.length === 0) {
    console.log("No enabled MCP servers configured; nothing to lock.");
    return;
  }

  // A global lock pins capability for every project on this machine, so it is
  // keyed by server id alone; the project lock stays the per-project override.
  const target = opts?.global === true ? globalMcpLockPath() : mcpLockPath(workdir);

  const pool = deps.createMcpPool({ servers, retry: opts?.retry });
  try {
    const locked: Record<string, Record<string, string>> = {};
    const hinted: Record<string, string[]> = {};
    for (const [id] of enabled) {
      const tools = await pool.listTools(id, workdir);
      locked[id] = Object.fromEntries(tools.map((tool) => [tool.name, schemaHash(tool.inputSchema)]));
      const readOnlyNames = tools.filter((tool) => tool.readOnly === true).map((tool) => tool.name);
      if (readOnlyNames.length > 0) hinted[id] = sortedNames(readOnlyNames);
      console.log(`${id}: ${tools.length} tool(s) locked`);
      if (tools.length === 0)
        console.log(`  (server advertised nothing - check \`${serverTarget(servers[id])}\` runs)`);
    }
    const readOnly = mergeReadOnly(carryReadOnlyGrants(await readMcpLockAt(target), locked), hinted);
    const lock = { version: 1 as const, servers: locked, ...(readOnly === undefined ? {} : { readOnly }) };
    await writeMcpLockAt(target, lock);
    console.log(`Wrote ${target}`);
  } finally {
    await pool.close();
  }
}

/**
 * The read-only grants a refreshed lock records: the servers' own `readOnly`
 * hints (the operator reviews and commits the lock, so writing one is the
 * deliberate step), plus any previously written grant still valid for its tool.
 */
function mergeReadOnly(
  carried: Record<string, string[]> | undefined,
  hinted: Record<string, string[]>,
): Record<string, string[]> | undefined {
  const merged: Record<string, string[]> = {};
  for (const source of [carried ?? {}, hinted]) {
    for (const [id, names] of Object.entries(source)) merged[id] = [...new Set([...(merged[id] ?? []), ...names])];
  }
  for (const id of Object.keys(merged)) merged[id] = sortedNames(merged[id] ?? []);
  return Object.keys(merged).length === 0 ? undefined : merged;
}
