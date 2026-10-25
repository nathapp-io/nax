/**
 * One `ToolProvider` (packages/nax-agent/src/tools/provider-types.ts) per configured MCP server.
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

import type { ProviderTool, ToolProvider } from "@nathapp/nax-agent";
import { validateProviderId } from "@nathapp/nax-agent";
import type { McpConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import { applyLock, lockedReadOnlyTools, MCP_LOCK_REFRESH_COMMAND, type McpLockFile, resolveMcpLock } from "./lock";
import type { McpPool } from "./pool";

export interface McpWithheldEntry {
  readonly serverId: string;
  readonly name: string;
  readonly reason: string;
  /** Which lock decided the withholding; `"none"` when no lock resolved. */
  readonly lockSource: "project" | "global" | "none";
}

/**
 * A lock as a read produced it: `readLock`'s documented return type is a bare
 * `McpLockFile`, and only `resolveMcpLock` annotates its result with `source`.
 */
type LockReadResult = McpLockFile & { readonly source?: "project" | "global" };

/**
 * Which lock decided a withholding. A stub returning a bare `McpLockFile` can
 * only stand for the project's own lock, so a lock with no `source` is
 * attributed to the project.
 */
function lockSourceOf(lock: LockReadResult | undefined): McpWithheldEntry["lockSource"] {
  if (lock === undefined) return "none";
  return lock.source ?? "project";
}

export function createMcpProviders(args: {
  config: McpConfig | undefined;
  pool: McpPool;
  projectRoot: string;
  storyId?: string;
  /** Seam for tests; defaults to resolving `.nax/mcp-lock.json` and then the global lock. */
  readLock?: (projectRoot: string) => Promise<McpLockFile | undefined>;
  onWithheld?: (entry: McpWithheldEntry) => void;
}): readonly ToolProvider[] {
  const servers = Object.entries(args.config?.servers ?? {}).filter(([, server]) => server.enabled);
  if (servers.length === 0) return [];

  // Validated once, at construction: a bad id must fail where the config is
  // read, not on the first hop that happens to reach this server.
  for (const [id] of servers) validateProviderId(id);

  const read: (projectRoot: string) => Promise<LockReadResult | undefined> = args.readLock ?? resolveMcpLock;
  // Memoized: the lock pins a capability surface, which does not change during a
  // run, and a per-hop filesystem read on the dispatch path is pure waste.
  let lockPromise: Promise<LockReadResult | undefined> | undefined;
  const lock = (): Promise<LockReadResult | undefined> => (lockPromise ??= read(args.projectRoot));

  return servers.map(([serverId, server]): ToolProvider => {
    let checkedInstructions = false;
    const instructions = async (workdir: string): Promise<string | undefined> => {
      const poolText = await args.pool.instructions?.(serverId, workdir);
      const configText = server.instructions?.replaceAll("{workdir}", () => workdir);
      return [poolText, configText].filter((text) => text !== undefined && text.length > 0).join("\n\n") || undefined;
    };
    return {
      id: serverId,
      kind: "discovered",
      stages: server.stages,
      instructions,
      async tools(workdir: string): Promise<readonly ProviderTool[]> {
        const discovered = await args.pool.listTools(serverId, workdir);
        // Claim before awaiting: concurrent listings and other workdirs must not warn twice.
        if (!checkedInstructions) {
          checkedInstructions = true;
          const text = await instructions(workdir).catch(() => undefined);
          warnWithheldInstructionTool({
            serverId,
            text,
            discovered,
            allowed: server.allowedTools,
            storyId: args.storyId,
          });
        }
        if (discovered.length === 0) return [];

        const resolved = await lock();
        const lockSource = lockSourceOf(resolved);
        const { admitted, withheld } = applyLock(resolved?.servers[serverId], discovered);
        for (const entry of withheld) {
          args.onWithheld?.({ serverId, name: entry.name, reason: entry.reason, lockSource });
          // The tool is never advertised, so no call is made and there is no
          // denial to carry a redirect. This log is where the refresh
          // instruction actually reaches a human.
          getSafeLogger()?.warn("mcp", `[provider] ${serverId}__${entry.name} withheld`, {
            storyId: args.storyId,
            serverId,
            tool: entry.name,
            reason: entry.reason,
            lockSource,
            refresh: MCP_LOCK_REFRESH_COMMAND,
          });
        }

        const allowed = server.allowedTools;
        const selected = allowed === undefined ? admitted : admitted.filter((tool) => allowed.includes(tool.name));

        // The hint is server-stated and untrusted: it counts only when the lock
        // also lists the tool as read-only for this server.
        const vouched = lockedReadOnlyTools(resolved, serverId);
        return selected.map((tool) => ({
          localName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.readOnly === true && vouched.has(tool.name) ? { readOnly: true as const } : {}),
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

/** One diagnostic per server; do not confuse a substring with a named tool. */
function warnWithheldInstructionTool(args: {
  serverId: string;
  text: string | undefined;
  discovered: readonly { name: string }[];
  allowed: readonly string[] | undefined;
  storyId: string | undefined;
}): void {
  if (!args.text || args.allowed === undefined) return;
  const tool = args.discovered.find(({ name }) => {
    if (args.allowed?.includes(name)) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(args.text ?? "");
  });
  if (tool === undefined) return;
  getSafeLogger()?.warn("mcp", `[provider] ${args.serverId} instructions name withheld tool ${tool.name}`, {
    storyId: args.storyId,
    serverId: args.serverId,
    tool: tool.name,
    reason: "allowedTools",
  });
}
