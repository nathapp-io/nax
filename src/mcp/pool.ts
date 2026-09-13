/**
 * Run-scoped MCP connections, keyed by (serverId, workdir).
 *
 * The workdir is in the key because nax runs stories in PARALLEL WORKTREES and a
 * server like codebase-memory-mcp is inherently cwd-scoped: it indexes a
 * repository. One run-scoped connection pointed at the main checkout would
 * answer every worktree's queries against the wrong tree — a silent wrong
 * answer, not a crash. Cost: one subprocess per active worktree per server.
 *
 * Requests are serialized per connection by construction: the turn loop
 * dispatches tool calls in a sequential `for` loop
 * (src/agents/native/session/turn-loop.ts:406), awaiting each before the next,
 * so one hop never has two calls in flight against one server.
 */

import type { McpServerConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import { connectMcpServer } from "./client";
import type { McpCallResult, McpConnection, McpToolDescriptor } from "./types";

/** Connect (and tools/list) deadline. Shorter than a call: a server that cannot start in 15s will not. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;

/** Mirrors `agent.native.transportRetry` (src/config/schemas-infra.ts) rather than inventing a shape. */
export const MCP_DEFAULT_RETRY = { maxAttempts: 3, baseDelayMs: 2000 } as const;

export type McpServerEvent = { readonly serverId: string; readonly workdir: string; readonly at: string } & (
  | { readonly kind: "connected"; readonly pid: number | null; readonly toolCount: number }
  | { readonly kind: "connect-failed"; readonly reason: string; readonly attempt: number }
  | { readonly kind: "closed" }
);

export interface McpPool {
  listTools(serverId: string, workdir: string): Promise<readonly McpToolDescriptor[]>;
  call(
    serverId: string,
    workdir: string,
    tool: string,
    input: Record<string, unknown>,
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<McpCallResult>;
  events(): readonly McpServerEvent[];
  close(): Promise<void>;
}

interface PidRegistryLike {
  register(pid: number): Promise<void>;
  unregister(pid: number): Promise<void>;
}

interface Entry {
  connection: McpConnection;
  tools: readonly McpToolDescriptor[];
}

export function createMcpPool(opts: {
  servers: Readonly<Record<string, McpServerConfig>>;
  pidRegistry?: PidRegistryLike;
  retry?: { maxAttempts: number; baseDelayMs: number };
  storyId?: string;
}): McpPool {
  const retry = opts.retry ?? MCP_DEFAULT_RETRY;
  // JSON.stringify, not a separator character: a workdir may contain anything a
  // filesystem allows, and a delimiter collision would silently merge two keys.
  const keyOf = (serverId: string, workdir: string): string => JSON.stringify([serverId, workdir]);
  const entries = new Map<string, Promise<Entry | undefined>>();
  const events: McpServerEvent[] = [];
  let closed = false;

  const record = (event: McpServerEvent): void => {
    events.push(event);
  };

  async function open(serverId: string, workdir: string): Promise<Entry | undefined> {
    const server = opts.servers[serverId];
    if (server === undefined || !server.enabled) return undefined;

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      // Declared above the try so the catch can tell "connect failed" — where
      // client.ts has already closed the transport — from "connected, then
      // tools/list failed", where the connection below must be reaped or its
      // subprocess becomes an orphan that outlives the pool (spec US-002).
      let connection: McpConnection | undefined;
      try {
        connection = await connectMcpServer({
          serverId,
          workdir,
          command: server.command,
          args: server.args,
          env: server.env,
          connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
        });
        const pid = connection.pid;
        if (pid !== null) await opts.pidRegistry?.register(pid).catch(() => {});
        const tools = await connection.listTools();
        record({ kind: "connected", serverId, workdir, at: new Date().toISOString(), pid, toolCount: tools.length });
        getSafeLogger()?.info("mcp", `[pool] ${serverId} connected`, {
          storyId: opts.storyId,
          serverId,
          workdir,
          pid,
          tools: tools.length,
        });
        return { connection, tools };
      } catch (error) {
        if (connection !== undefined) {
          const pid = connection.pid;
          await connection.close().catch(() => {});
          if (pid !== null) await opts.pidRegistry?.unregister(pid).catch(() => {});
        }
        const reason = error instanceof Error ? error.message : String(error);
        record({ kind: "connect-failed", serverId, workdir, at: new Date().toISOString(), reason, attempt });
        getSafeLogger()?.warn("mcp", `[pool] ${serverId} connect failed`, {
          storyId: opts.storyId,
          serverId,
          workdir,
          attempt,
          error: reason,
        });
        if (attempt < retry.maxAttempts && retry.baseDelayMs > 0) {
          await Bun.sleep(retry.baseDelayMs * attempt);
        }
      }
    }
    // Spec R8: failure degrades. The undefined entry is CACHED, so a wedged
    // server costs its attempt budget once per (server, workdir) per run rather
    // than on every hop.
    return undefined;
  }

  function entry(serverId: string, workdir: string): Promise<Entry | undefined> {
    if (closed) return Promise.resolve(undefined);
    const key = keyOf(serverId, workdir);
    const existing = entries.get(key);
    if (existing !== undefined) return existing;
    // Memoize the PROMISE, not the result: concurrent first use must await one
    // in-flight connect, never start a second subprocess.
    const pending = open(serverId, workdir);
    entries.set(key, pending);
    return pending;
  }

  return {
    async listTools(serverId, workdir) {
      return (await entry(serverId, workdir))?.tools ?? [];
    },

    async call(serverId, workdir, tool, input, callOpts) {
      const resolved = await entry(serverId, workdir);
      if (resolved === undefined) {
        // Error AS DATA (ADR-029 section 5, spec US-006): a dead server must not
        // throw into the turn loop, which would end the hop.
        const content = `MCP server "${serverId}" is unavailable; its tools cannot be called for this hop.`;
        return { content, isError: true, bytesPreTruncation: Buffer.byteLength(content, "utf8") };
      }
      try {
        // Belt and braces: the SDK honours `timeout` per request, but a
        // transport wedged below the protocol layer (a child that accepted the
        // write and never answers) would otherwise hold the hop open. The
        // ceiling lives here so it is enforced whatever the transport does.
        const deadline = new Promise<McpCallResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                content: `MCP call ${serverId}__${tool} exceeded ${callOpts.timeoutMs}ms`,
                isError: true,
                bytesPreTruncation: 0,
              }),
            callOpts.timeoutMs,
          ).unref?.(),
        );
        return await Promise.race([resolved.connection.callTool(tool, input, callOpts), deadline]);
      } catch (error) {
        const content = `MCP server "${serverId}" is unavailable: ${String(error)}`;
        return { content, isError: true, bytesPreTruncation: Buffer.byteLength(content, "utf8") };
      }
    },

    events() {
      return events;
    },

    async close() {
      if (closed) return;
      closed = true;
      const pending = [...entries.values()];
      entries.clear();
      const settled = await Promise.allSettled(pending);
      await Promise.allSettled(
        settled.map(async (result) => {
          if (result.status !== "fulfilled" || result.value === undefined) return;
          const { connection } = result.value;
          const pid = connection.pid;
          await connection.close();
          if (pid !== null) await opts.pidRegistry?.unregister(pid).catch(() => {});
          record({
            kind: "closed",
            serverId: connection.serverId,
            workdir: connection.workdir,
            at: new Date().toISOString(),
          });
        }),
      );
    },
  };
}
