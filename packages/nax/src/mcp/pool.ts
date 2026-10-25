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
 * (`packages/nax-agent/src/native/session/turn-loop.ts`), awaiting each before the next,
 * so one hop never has two calls in flight against one server.
 */

import type { McpServerConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import { assertTrusted } from "@/trust";
import { cancellableDelay } from "@/utils/bun-deps";
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
  instructions?(serverId: string, workdir: string): Promise<string | undefined>;
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

/** Shortest header-value token redacted on its own (shorter ones would mangle ordinary words). */
const MIN_HEADER_TOKEN_LENGTH = 4;
const REDACTED = "***";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A secret as it may appear in an error: raw, decoded and re-encoded. */
function secretForms(raw: string): string[] {
  if (raw === "") return [];
  const decoded = safeDecode(raw);
  return [raw, decoded, encodeURIComponent(decoded)];
}

function urlSecrets(rawUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }
  const queryValues = url.search
    .slice(1)
    .split("&")
    .map((pair) => pair.slice(pair.indexOf("=") + 1));
  const decodedValues = [...url.searchParams.values()];
  return [url.username, url.password, ...queryValues, ...decodedValues, url.hash.slice(1)].flatMap(secretForms);
}

function headerSecrets(headers: Record<string, string>): string[] {
  return Object.values(headers).flatMap((value) => {
    const tokens = value.split(/\s+/).filter((token) => token.length >= MIN_HEADER_TOKEN_LENGTH);
    return [value, ...tokens].flatMap(secretForms);
  });
}

/**
 * Error text with a server's secret parts replaced by `***`. The secrets are the
 * url's username and password, every non-empty query value, the fragment, and
 * each header value (plus its long whitespace-separated tokens), in raw, decoded
 * and encoded forms. Redacted by part, never by matching the whole configured
 * string: an error usually quotes a fragment of the url, not all of it.
 */
export function redactMcpReason(text: string, server: McpServerConfig): string {
  const secrets = [...(server.url === undefined ? [] : urlSecrets(server.url)), ...headerSecrets(server.headers ?? {})];
  // Longest first, so a secret that contains another is replaced whole.
  const ordered = [...new Set(secrets.filter((secret) => secret !== ""))].sort((a, b) => b.length - a.length);
  return ordered.reduce((out, secret) => out.replaceAll(secret, REDACTED), text);
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
  const controller = new AbortController();
  const { signal } = controller;
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

    // Trust backstop (US-005): an MCP server entry is repository-controlled —
    // merged config chooses the binary that gets spawned. Asserted before the
    // retry loop and outside its try, so the refusal propagates from
    // listTools/call as a rejection instead of degrading into connect-failed
    // error-as-data.
    await assertTrusted(workdir, "mcp");

    for (let attempt = 1; attempt <= retry.maxAttempts && !signal.aborted; attempt++) {
      // Declared above the try so the catch can tell "connect failed" — where
      // client.ts has already closed the transport — from "connected, then
      // tools/list failed", where the connection below must be reaped or its
      // subprocess becomes an orphan that outlives the pool (spec US-002).
      let connection: McpConnection | undefined;
      let spawnedPid: number | undefined;
      let registration: Promise<void> | undefined;
      try {
        connection = await connectMcpServer({
          serverId,
          workdir,
          command: server.command,
          url: server.url,
          headers: server.headers,
          args: server.args,
          env: server.env,
          connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
          signal,
          onSpawn(pid) {
            spawnedPid = pid;
            // Invoke immediately: a hard exit during initialize must see this pid.
            registration = opts.pidRegistry?.register(pid).catch(() => {});
          },
        });
        signal.throwIfAborted();
        await registration;
        const pid = connection.pid;
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
        if (connection !== undefined) await connection.close().catch(() => {});
        // connect has rejected (and reaped its half-open transport) before removal.
        await registration;
        if (spawnedPid !== undefined) await opts.pidRegistry?.unregister(spawnedPid).catch(() => {});
        const reason = redactMcpReason(error instanceof Error ? error.message : String(error), server);
        record({ kind: "connect-failed", serverId, workdir, at: new Date().toISOString(), reason, attempt });
        getSafeLogger()?.warn("mcp", `[pool] ${serverId} connect failed`, {
          storyId: opts.storyId,
          serverId,
          workdir,
          attempt,
          error: reason,
        });
        if (attempt < retry.maxAttempts && retry.baseDelayMs > 0 && !signal.aborted) {
          await cancellableDelay(retry.baseDelayMs * attempt, signal).catch(() => {});
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
    async instructions(serverId, workdir) {
      return (await entry(serverId, workdir))?.connection.instructions;
    },

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
        //
        // MEM-5: own the deadline through an AbortController so the `finally`
        // clears cancellableDelay's internal setTimeout whichever side of the
        // race wins. The prior inline `setTimeout(...).unref?.()` discarded the
        // handle, so every call — instant returns included — left the timer
        // armed for the full timeoutMs. Same fix shape as trackedSpawn (PERF-1).
        const deadlineController = new AbortController();
        const deadline = cancellableDelay(callOpts.timeoutMs, deadlineController.signal).catch(() => {});
        try {
          return await Promise.race([
            resolved.connection.callTool(tool, input, callOpts),
            deadline.then(
              (): McpCallResult => ({
                content: `MCP call ${serverId}__${tool} exceeded ${callOpts.timeoutMs}ms`,
                isError: true,
                bytesPreTruncation: 0,
              }),
            ),
          ]);
        } finally {
          deadlineController.abort();
        }
      } catch (error) {
        const server = opts.servers[serverId];
        const detail = server === undefined ? String(error) : redactMcpReason(String(error), server);
        const content = `MCP server "${serverId}" is unavailable: ${detail}`;
        return { content, isError: true, bytesPreTruncation: Buffer.byteLength(content, "utf8") };
      }
    },

    events() {
      return events;
    },

    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
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
