/**
 * `nax mcp lock` — refresh `.nax/mcp-lock.json` from what each configured
 * server advertises right now. `--global` writes `<globalDir>/mcp-lock.json`
 * instead, for servers configured once in `~/.nax/config.json` (US-002).
 *
 * Connects every enabled server ONCE, at the project root. That is deliberate:
 * the lock pins a server's capability surface, which does not vary per worktree,
 * even though connections at runtime do (spec R7).
 */
import { loadConfig, type McpServerConfig } from "@/config";
// The BARREL, not `@/mcp/pool` — `check:alias-internals` forbids a value import
// of `@/<dir>/<internal>` from `src/` once `src/<dir>/index.ts` exists.
import { createMcpPool, globalMcpLockPath, mcpLockPath, schemaHash, writeMcpLock, writeMcpLockAt } from "@/mcp";

/** What to tell the operator to check: the url of an HTTP server, the command of a stdio one. */
function serverTarget(server: McpServerConfig | undefined): string {
  return server?.url ?? server?.command ?? "(unconfigured)";
}

// `loadConfig(startDir)` — NOT `loadConfigForWorkdir`, whose first argument is a
// config FILE path (src/config/loader.ts:403), not a directory. Every other CLI
// command loads this way (src/cli/setup.ts:31, src/cli/generate.ts:56).
export async function runMcpLockCommand(workdir: string, opts?: { global?: boolean }): Promise<void> {
  const config = await loadConfig(workdir);
  const servers = config.mcp?.servers ?? {};
  const enabled = Object.entries(servers).filter(([, server]) => server.enabled);
  if (enabled.length === 0) {
    console.log("No enabled MCP servers configured; nothing to lock.");
    return;
  }

  // A global lock pins capability for every project on this machine, so it is
  // keyed by server id alone; the project lock stays the per-project override.
  const target = opts?.global === true ? globalMcpLockPath() : mcpLockPath(workdir);

  const pool = createMcpPool({ servers });
  try {
    const locked: Record<string, Record<string, string>> = {};
    for (const [id] of enabled) {
      const tools = await pool.listTools(id, workdir);
      locked[id] = Object.fromEntries(tools.map((tool) => [tool.name, schemaHash(tool.inputSchema)]));
      console.log(`${id}: ${tools.length} tool(s) locked`);
      if (tools.length === 0)
        console.log(`  (server advertised nothing - check \`${serverTarget(servers[id])}\` runs)`);
    }
    const lock = { version: 1 as const, servers: locked };
    if (opts?.global === true) await writeMcpLockAt(target, lock);
    else await writeMcpLock(workdir, lock);
    console.log(`Wrote ${target}`);
  } finally {
    await pool.close();
  }
}
