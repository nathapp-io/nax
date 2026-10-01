/**
 * `nax mcp lock` — refresh `.nax/mcp-lock.json` from what each configured
 * server advertises right now.
 *
 * Connects every enabled server ONCE, at the project root. That is deliberate:
 * the lock pins a server's capability surface, which does not vary per worktree,
 * even though connections at runtime do (spec R7).
 */
import { loadConfig } from "@/config";
// The BARREL, not `@/mcp/pool` — `check:alias-internals` forbids a value import
// of `@/<dir>/<internal>` from `src/` once `src/<dir>/index.ts` exists.
import { createMcpPool, mcpLockPath, schemaHash, writeMcpLock } from "@/mcp";

// `loadConfig(startDir)` — NOT `loadConfigForWorkdir`, whose first argument is a
// config FILE path (src/config/loader.ts:403), not a directory. Every other CLI
// command loads this way (src/cli/setup.ts:31, src/cli/generate.ts:56).
export async function runMcpLockCommand(workdir: string): Promise<void> {
  const config = await loadConfig(workdir);
  const servers = config.mcp?.servers ?? {};
  const enabled = Object.entries(servers).filter(([, server]) => server.enabled);
  if (enabled.length === 0) {
    console.log("No enabled MCP servers configured; nothing to lock.");
    return;
  }

  const pool = createMcpPool({ servers });
  try {
    const locked: Record<string, Record<string, string>> = {};
    for (const [id] of enabled) {
      const tools = await pool.listTools(id, workdir);
      locked[id] = Object.fromEntries(tools.map((tool) => [tool.name, schemaHash(tool.inputSchema)]));
      console.log(`${id}: ${tools.length} tool(s) locked`);
      if (tools.length === 0) console.log(`  (server advertised nothing - check \`${servers[id]?.command}\` runs)`);
    }
    await writeMcpLock(workdir, { version: 1, servers: locked });
    console.log(`Wrote ${mcpLockPath(workdir)}`);
  } finally {
    await pool.close();
  }
}
