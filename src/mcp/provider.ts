/**
 * One `ToolProvider` (src/tools/provider-types.ts) per configured MCP server.
 *
 * The provider id IS the config key, which makes one identifier carry across
 * `mcp.servers.<id>`, the advertised name `<id>__<tool>`, the ledger's
 * `provider` field and every denial message. Ruling D1 of this plan: the
 * spec's `mcp__<server>__<tool>` is unreachable because `namespacedToolName`
 * owns the namespace and `validateProviderId` forbids `__` inside an id.
 *
 * WHICH WORKDIR: `tools(workdir)` receives the HOP'S PERMITTED ROOT from
 * `resolveProviderTools`, and every `run()` closure below captures THAT value.
 * Reaching for the runtime's workdir instead — which is right there on the
 * object the pool hangs off — silently reintroduces the stale-index bug spec R7
 * exists to prevent, and it passes every test that does not use two worktrees.
 */
import type { McpConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import type { ProviderTool, ToolProvider } from "@/tools";
import { validateProviderId } from "@/tools";
import { applyLock, MCP_LOCK_REFRESH_COMMAND, type McpLockFile, readMcpLock } from "./lock";
import type { McpPool } from "./pool";

export interface McpWithheldEntry {
  readonly serverId: string;
  readonly name: string;
  readonly reason: string;
}

export function createMcpProviders(args: {
  config: McpConfig | undefined;
  pool: McpPool;
  projectRoot: string;
  storyId?: string;
  /** Seam for tests; defaults to reading `.nax/mcp-lock.json` under projectRoot. */
  readLock?: (projectRoot: string) => Promise<McpLockFile | undefined>;
  onWithheld?: (entry: McpWithheldEntry) => void;
}): readonly ToolProvider[] {
  const servers = Object.entries(args.config?.servers ?? {}).filter(([, server]) => server.enabled);
  if (servers.length === 0) return [];

  // Validated once, at construction: a bad id must fail where the config is
  // read, not on the first hop that happens to reach this server.
  for (const [id] of servers) validateProviderId(id);

  const read = args.readLock ?? readMcpLock;
  // Memoized: the lock pins a capability surface, which does not change during a
  // run, and a per-hop filesystem read on the dispatch path is pure waste.
  let lockPromise: Promise<McpLockFile | undefined> | undefined;
  const lock = (): Promise<McpLockFile | undefined> => (lockPromise ??= read(args.projectRoot));

  return servers.map(([serverId, server]): ToolProvider => {
    return {
      id: serverId,
      kind: "discovered",
      stages: server.stages,
      async tools(workdir: string): Promise<readonly ProviderTool[]> {
        const discovered = await args.pool.listTools(serverId, workdir);
        if (discovered.length === 0) return [];

        const { admitted, withheld } = applyLock((await lock())?.servers[serverId], discovered);
        for (const entry of withheld) {
          args.onWithheld?.({ serverId, name: entry.name, reason: entry.reason });
          // The tool is never advertised, so no call is made and there is no
          // denial to carry a redirect. This log is where the refresh
          // instruction actually reaches a human.
          getSafeLogger()?.warn("mcp", `[provider] ${serverId}__${entry.name} withheld`, {
            storyId: args.storyId,
            serverId,
            tool: entry.name,
            reason: entry.reason,
            refresh: MCP_LOCK_REFRESH_COMMAND,
          });
        }

        const allowed = server.allowedTools;
        const selected = allowed === undefined ? admitted : admitted.filter((tool) => allowed.includes(tool.name));

        return selected.map((tool) => ({
          localName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          run: async (input, ctx) => {
            const result = await args.pool.call(serverId, workdir, tool.name, input, {
              timeoutMs: server.timeoutMs,
              maxBytes: ctx.maxBytes,
            });
            return {
              content: result.content,
              ...(result.isError ? { isError: true } : {}),
              resultBytesPreTruncation: result.bytesPreTruncation,
            };
          },
        }));
      },
    };
  });
}
