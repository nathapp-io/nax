/**
 * nax#2410 D6 — the end-of-run MCP adoption summary.
 *
 * Aggregates the run's tool-audit files (transport-agnostic: both the native
 * sink and the ACP recorder write the same shapes): a session OFFERS server S
 * when its `toolSurface.advertised` names S with content, and CALLS S when any
 * row's `provider` is S or its `tool` carries the `<id>__` namespace. A server
 * that was offered and never called is the silent gap this summary exposes.
 */
import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { getSafeLogger, type Logger } from "@/logger";

export type McpAdoptionSummary = Readonly<
  Record<string, { sessionsOffered: number; sessionsCalled: number; totalCalls: number }>
>;

/** Injectable fs for tests — the `_deps` seam pattern. */
export const _mcpAdoptionDeps: {
  readdir: (dir: string) => Promise<readonly string[]>;
  readFile: (path: string) => Promise<string>;
} = {
  readdir: (dir) => fsReaddir(dir),
  readFile: (path) => fsReadFile(path, "utf8"),
};

interface AuditFileBody {
  toolSurface?: { advertised?: readonly { providerId: string; names?: readonly string[] }[] };
  calls?: readonly { provider?: string; tool?: string }[];
}

async function readBodies(auditDir: string, runId: string | undefined): Promise<AuditFileBody[]> {
  try {
    const files = await _mcpAdoptionDeps.readdir(auditDir);
    // The tree appends across runs (tool-audit/<feature>/); without the runId
    // filter one historical call would mask this run's zero adoption forever.
    const current = runId === undefined ? files : files.filter((file) => file.startsWith(`${runId}-`));
    const bodies = await Promise.all(
      current
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            return JSON.parse(await _mcpAdoptionDeps.readFile(join(auditDir, file))) as AuditFileBody;
          } catch {
            // One unreadable ledger file must not hide the others.
            return undefined;
          }
        }),
    );
    return bodies.filter((body): body is AuditFileBody => body !== undefined);
  } catch {
    // No audit dir at all: every configured server counts zero.
    return [];
  }
}

export async function summarizeMcpAdoption(args: {
  serverIds: readonly string[];
  auditDir: string;
  /** Scope the aggregation to one run's files (files are prefixed `<runId>-`). */
  runId?: string;
}): Promise<McpAdoptionSummary> {
  const bodies = await readBodies(args.auditDir, args.runId);
  const summary: Record<string, { sessionsOffered: number; sessionsCalled: number; totalCalls: number }> = {};
  for (const serverId of args.serverIds) {
    let sessionsOffered = 0;
    let sessionsCalled = 0;
    let totalCalls = 0;
    for (const body of bodies) {
      const offered = (body.toolSurface?.advertised ?? []).some(
        (entry) => entry.providerId === serverId && (entry.names?.length ?? 0) > 0,
      );
      const calls = (body.calls ?? []).filter(
        (row) => row.provider === serverId || row.tool?.startsWith(`${serverId}__`) === true,
      ).length;
      if (offered) sessionsOffered += 1;
      if (calls > 0) sessionsCalled += 1;
      totalCalls += calls;
    }
    summary[serverId] = { sessionsOffered, sessionsCalled, totalCalls };
  }
  return summary;
}

/** The zero-adoption WARN lines (D6): offered but never called, once per server. */
export function warnZeroAdoption(
  summary: McpAdoptionSummary,
  logger: Logger | undefined | null = getSafeLogger(),
): void {
  for (const [serverId, stats] of Object.entries(summary)) {
    if (stats.sessionsOffered > 0 && stats.totalCalls === 0) {
      logger?.warn("mcp", `mcp: ${serverId} was offered to ${stats.sessionsOffered} session(s) and never called`, {
        serverId,
        ...stats,
      });
    }
  }
}
