/**
 * Per-run MCP server rollup.
 *
 * Server LIFECYCLE belongs here rather than in `ToolCallRecord`, whose
 * semantics are strictly per-call: a run must be able to answer "was
 * codebase-memory actually attached?" without log spelunking, and a server that
 * failed to connect made no calls to look for.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerEvent } from "./pool";
import type { McpWithheldEntry } from "./provider";

export interface McpServerSummary {
  readonly serverId: string;
  readonly workdirs: number;
  readonly connected: number;
  readonly failed: number;
  /**
   * Times an attached server's connection went away mid-run, whether or not the
   * pool replaced it. A run whose `connected` count is below its `disconnected`
   * count lost its tools more than once.
   */
  readonly disconnected: number;
  readonly toolsAdvertised: number;
}

export interface McpRunRollup {
  readonly runId: string;
  readonly servers: readonly McpServerSummary[];
  readonly withheld: readonly McpWithheldEntry[];
  readonly events: readonly McpServerEvent[];
}

/** What one server's events add up to before they become a `McpServerSummary`. */
interface ServerAccumulator {
  readonly workdirs: Set<string>;
  connected: number;
  failed: number;
  disconnected: number;
  tools: number;
}

export function buildMcpRollup(args: {
  runId: string;
  events: readonly McpServerEvent[];
  withheld: readonly McpWithheldEntry[];
}): McpRunRollup {
  const byServer = new Map<string, ServerAccumulator>();
  for (const event of args.events) {
    const entry = byServer.get(event.serverId) ?? {
      workdirs: new Set<string>(),
      connected: 0,
      failed: 0,
      disconnected: 0,
      tools: 0,
    };
    entry.workdirs.add(event.workdir);
    if (event.kind === "connected") {
      entry.connected++;
      entry.tools = Math.max(entry.tools, event.toolCount);
    } else if (event.kind === "connect-failed") {
      entry.failed++;
    } else if (event.kind === "disconnected") {
      // Both halves of the reconnect decision count: a server that was pinned
      // unavailable after `MCP_MAX_RECONNECTS` exits lost its tools just as hard
      // as one the pool replaced.
      entry.disconnected++;
    }
    byServer.set(event.serverId, entry);
  }

  return {
    runId: args.runId,
    servers: [...byServer.entries()].map(([serverId, entry]) => ({
      serverId,
      workdirs: entry.workdirs.size,
      connected: entry.connected,
      // One failed attempt per connect budget is expected noise; the count is
      // what distinguishes "retried once and recovered" from "never came up".
      failed: entry.failed,
      disconnected: entry.disconnected,
      toolsAdvertised: entry.tools,
    })),
    withheld: args.withheld,
    events: args.events,
  };
}

export async function writeMcpRollup(outputDir: string, rollup: McpRunRollup): Promise<void> {
  if (rollup.servers.length === 0 && rollup.withheld.length === 0) return;
  const dir = join(outputDir, "mcp");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${rollup.runId}-servers.json`), `${JSON.stringify(rollup, null, 2)}\n`);
}
