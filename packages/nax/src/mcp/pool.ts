/**
 * Run-scoped MCP connections, keyed by (serverId, workdir).
 *
 * The workdir is in the key because nax runs stories in PARALLEL WORKTREES and a
 * server like codebase-memory-mcp is inherently cwd-scoped: it indexes a
 * repository. One run-scoped connection pointed at the main checkout would
 * answer every worktree's queries against the wrong tree — a silent wrong
 * answer, not a crash. Cost: one subprocess per active worktree per server.
 *
 * The turn loop dispatches a hop's tool calls sequentially
 * (`packages/nax-agent/src/native/session/turn-loop.ts`), awaiting each before
 * the next, but concurrency on one key is still possible: several hops and chat
 * share the run-scoped connection, so two callers can have calls in flight
 * against one server at once. Nothing here serializes them, so an exit can cut
 * off more than one call. Each such call is retried once through `entry()`,
 * whose memoized open promise hands every caller the same single replacement
 * connection — the exit is counted once, because the shared layer reports it
 * once.
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

/**
 * Replacements a (serverId, workdir) key may buy in one run: it connects at most
 * `1 + MCP_MAX_RECONNECTS` times. One extra exit past that pins the key to the
 * cached-unavailable state a failed connect leaves (spec R8), so a server that
 * flaps on every hop costs four subprocesses per run rather than one per hop.
 */
export const MCP_MAX_RECONNECTS = 3;

export type McpServerEvent = { readonly serverId: string; readonly workdir: string; readonly at: string } & (
  | { readonly kind: "connected"; readonly pid: number | null; readonly toolCount: number }
  | { readonly kind: "connect-failed"; readonly reason: string; readonly attempt: number }
  | { readonly kind: "disconnected"; readonly reason: string; readonly reconnect: boolean }
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

/** A secret as it may appear in an error: raw, decoded, and the raw and decoded forms re-encoded. */
function secretForms(raw: string): string[] {
  if (raw === "") return [];
  const decoded = safeDecode(raw);
  return [raw, decoded, encodeURIComponent(raw), encodeURIComponent(decoded)];
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
 * A url safe to print: scheme, host and path stay (the operator needs to know
 * which endpoint), while credentials and the fragment are dropped and every
 * query value becomes `***`. An unparseable url is not echoed at all.
 */
export function redactMcpUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "(unparseable url)";
  }
  const query = [...url.searchParams.keys()].map((key) => `${encodeURIComponent(key)}=${REDACTED}`).join("&");
  return `${url.protocol}//${url.host}${url.pathname}${query === "" ? "" : `?${query}`}`;
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
  /**
   * The pid this connection's process had, kept for lifecycle cleanup. Read from
   * the retained spawn report, not the live getter: a server that exits while
   * the pid registration is still pending makes `connection.pid` read null, and
   * the registration would then never be undone (B1).
   */
  pid: number | null;
}

/** One dispatch's outcome: a rejected `callTool` is handed back, never thrown. */
type Attempt = { readonly ok: true; readonly result: McpCallResult } | { readonly ok: false; readonly error: unknown };

interface AttemptRequest {
  readonly serverId: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly callOpts: { timeoutMs: number; maxBytes: number };
  readonly connection: McpConnection;
}

/** The per-hop failure a call answers when no live connection could take it (spec R8). */
function unavailableForHop(serverId: string): McpCallResult {
  const content = `MCP server "${serverId}" is unavailable; its tools cannot be called for this hop.`;
  return { content, isError: true, bytesPreTruncation: Buffer.byteLength(content, "utf8") };
}

/** Error AS DATA for a call a connection rejected (ADR-029 section 5, spec US-006). */
function rejectionResult(serverId: string, error: unknown, server: McpServerConfig | undefined): McpCallResult {
  const detail = server === undefined ? String(error) : redactMcpReason(String(error), server);
  const content = `MCP server "${serverId}" is unavailable: ${detail}`;
  return { content, isError: true, bytesPreTruncation: Buffer.byteLength(content, "utf8") };
}

/**
 * Send one call under its OWN deadline, reporting a rejection instead of
 * throwing it: the caller decides whether it is retryable. The deadline lives
 * here so each retry gets a fresh one, and so the `finally` clears
 * `cancellableDelay`'s timer whichever side of the race wins (MEM-5).
 */
async function attemptOf(request: AttemptRequest): Promise<Attempt> {
  // Belt and braces: the SDK honours `timeout` per request, but a transport
  // wedged below the protocol layer (a child that accepted the write and never
  // answers) would otherwise hold the hop open.
  const deadlineController = new AbortController();
  const deadline = cancellableDelay(request.callOpts.timeoutMs, deadlineController.signal).catch(() => {});
  try {
    const timedOut = (): McpCallResult => ({
      content: `MCP call ${request.serverId}__${request.tool} exceeded ${request.callOpts.timeoutMs}ms`,
      isError: true,
      bytesPreTruncation: 0,
    });
    // A deadline is a RESULT, not a rejection: it is never retried.
    const sent = request.connection.callTool(request.tool, request.input, request.callOpts);
    return { ok: true, result: await Promise.race([sent, deadline.then(timedOut)]) };
  } catch (error) {
    return { ok: false, error };
  } finally {
    deadlineController.abort();
  }
}

/**
 * The cached-undefined entry a failed connect leaves (spec R8), shared by every
 * key pinned by the reconnect budget: `entry()` hands it back, so the next call
 * answers error-as-data without opening anything.
 */
const PINNED_UNAVAILABLE: Promise<undefined> = Promise.resolve(undefined);

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
  /**
   * The `open()` call whose result is current for a key. A listener evicts only
   * while its own token is still current, so a repeated exit report from a
   * connection that was already replaced never touches the key.
   */
  const openTokens = new Map<string, number>();
  let nextOpenToken = 0;
  /**
   * Disconnects per key, counted once per exit that reaches the key (a repeat
   * report from an already-replaced connection is ignored before this). Past
   * `MCP_MAX_RECONNECTS` the key is pinned unavailable instead of evicted.
   */
  const disconnects = new Map<string, number>();
  /**
   * Connections that reported an exit. Recorded per connection, not per key: a
   * call that failed may only be re-dispatched while it is still in doubt
   * whether its connection is dead (US-003 reads this).
   */
  const reportedClose = new WeakSet<McpConnection>();
  const events: McpServerEvent[] = [];
  let closed = false;

  const record = (event: McpServerEvent): void => {
    events.push(event);
  };

  /**
   * A connection's stdio process exited. Everything that decides the key's fate
   * happens synchronously, before any await: the exit may be reported from
   * inside `open()` itself (before it returns), and the next `entry()` runs in
   * that same turn.
   */
  function evict(args: {
    key: string;
    serverId: string;
    workdir: string;
    connection: McpConnection;
    /** The pid read at connect time: the live getter may already read null. */
    pid: number | null;
    token: number;
    reason: string;
  }): void {
    reportedClose.add(args.connection);
    if (closed || openTokens.get(args.key) !== args.token) return;
    const counted = (disconnects.get(args.key) ?? 0) + 1;
    disconnects.set(args.key, counted);
    // Cleared before the split below: a repeated exit report from this
    // connection is ignored whether the key reconnects or is pinned.
    openTokens.delete(args.key);
    // Budget arithmetic: a key connects 1 + MCP_MAX_RECONNECTS times. The exit
    // that exhausts it does not evict — it pins the key to the cached-undefined
    // state a failed connect leaves (spec R8), so later calls answer
    // error-as-data without spawning anything.
    const reconnect = counted <= MCP_MAX_RECONNECTS;
    if (reconnect) entries.delete(args.key);
    else entries.set(args.key, PINNED_UNAVAILABLE);
    const server = opts.servers[args.serverId];
    const reason = server === undefined ? args.reason : redactMcpReason(args.reason, server);
    record({
      kind: "disconnected",
      serverId: args.serverId,
      workdir: args.workdir,
      at: new Date().toISOString(),
      reason,
      reconnect,
    });
    getSafeLogger()?.warn("mcp", `[pool] ${args.serverId} disconnected`, {
      storyId: opts.storyId,
      serverId: args.serverId,
      workdir: args.workdir,
      reason,
      reconnect,
    });
    // Asynchronously reap the dead transport and its pid, exactly as the
    // connect-failure path does. Both rejections are swallowed: the key is
    // already gone above, and a failing cleanup must not undo that.
    void args.connection.close().catch(() => {});
    if (args.pid !== null) void opts.pidRegistry?.unregister(args.pid).catch(() => {});
  }

  /** What one connect attempt left behind when it failed, for `reportConnectFailure`. */
  interface FailedAttempt {
    readonly serverId: string;
    readonly workdir: string;
    readonly server: McpServerConfig;
    readonly attempt: number;
    readonly error: unknown;
    /** The connection the attempt produced, when the handshake got that far. */
    readonly connection: McpConnection | undefined;
    /** The in-flight pid registration, awaited so the registry settles in order. */
    readonly registration: Promise<void> | undefined;
    readonly spawnedPid: number | undefined;
  }

  /**
   * A connect attempt failed: reap whatever it started, tell the pid registry
   * the spawn is gone, and record why. Kept out of `open()` so its retry loop
   * stays under the complexity ratchet; the order and the fields are unchanged.
   */
  async function reportConnectFailure(failed: FailedAttempt): Promise<void> {
    // client.ts has already closed a half-open transport; a connection it DID
    // hand back must be reaped here or its subprocess outlives the pool.
    if (failed.connection !== undefined) await failed.connection.close().catch(() => {});
    await failed.registration;
    if (failed.spawnedPid !== undefined) await opts.pidRegistry?.unregister(failed.spawnedPid).catch(() => {});
    const reason = redactMcpReason(
      failed.error instanceof Error ? failed.error.message : String(failed.error),
      failed.server,
    );
    record({
      kind: "connect-failed",
      serverId: failed.serverId,
      workdir: failed.workdir,
      at: new Date().toISOString(),
      reason,
      attempt: failed.attempt,
    });
    getSafeLogger()?.warn("mcp", `[pool] ${failed.serverId} connect failed`, {
      storyId: opts.storyId,
      serverId: failed.serverId,
      workdir: failed.workdir,
      attempt: failed.attempt,
      error: reason,
    });
  }

  async function open(serverId: string, workdir: string, token: number): Promise<Entry | undefined> {
    const server = opts.servers[serverId];
    if (server === undefined || !server.enabled) return undefined;
    const key = keyOf(serverId, workdir);

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
        const connected = await connectMcpServer({
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
        connection = connected;
        signal.throwIfAborted();
        await registration;
        // The pid the process actually had: the retained spawn report first,
        // then the connection's own at connect time. Reading the live getter
        // alone loses the pid when the server exits during `await registration`
        // — the registration stands, and the replay below would evict without
        // unregistering it (B1).
        const pid = spawnedPid ?? connected.pid;
        const tools = await connected.listTools();
        record({ kind: "connected", serverId, workdir, at: new Date().toISOString(), pid, toolCount: tools.length });
        getSafeLogger()?.info("mcp", `[pool] ${serverId} connected`, {
          storyId: opts.storyId,
          serverId,
          workdir,
          pid,
          tools: tools.length,
        });
        // Listen only AFTER the connected event is recorded. The shared layer
        // reports an exit it saw before anyone listened from inside onClose
        // itself, so registering earlier would let `disconnected` precede
        // `connected` and chat `/mcp`, which shows the latest event, would call
        // a dead server connected.
        connected.onClose((reason) => evict({ key, serverId, workdir, connection: connected, pid, token, reason }));
        // Nothing writes the entry back after this point: a listener that fired
        // synchronously above already evicted the key, and reinstalling it here
        // would resurrect the dead connection.
        return { connection: connected, tools, pid };
      } catch (error) {
        await reportConnectFailure({ serverId, workdir, server, attempt, error, connection, registration, spawnedPid });
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
    // in-flight connect, never start a second subprocess. `open` runs through
    // its first await before returning, and no continuation can run before this
    // frame ends — so both the promise and the current-open token are installed
    // before the listener this open registers can fire and evict the key.
    const token = ++nextOpenToken;
    const pending = open(serverId, workdir, token);
    entries.set(key, pending);
    openTokens.set(key, token);
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
      const request = (connection: McpConnection): AttemptRequest => ({
        serverId,
        tool,
        input,
        callOpts,
        connection,
      });
      // Error AS DATA, never a throw into the turn loop, which would end the hop.
      const resolved = await entry(serverId, workdir);
      if (resolved === undefined) return unavailableForHop(serverId);
      const first = await attemptOf(request(resolved.connection));
      if (first.ok) return first.result;
      // Only a rejection on a connection that REPORTED a close is retryable: a
      // deadline is a result, and a transport error on an open connection keeps
      // today's answer with no eviction and no retry.
      if (!reportedClose.has(resolved.connection)) {
        return rejectionResult(serverId, first.error, opts.servers[serverId]);
      }
      getSafeLogger()?.debug("mcp", `[pool] ${serverId} retrying an interrupted call`, {
        storyId: opts.storyId,
        serverId,
        workdir,
        tool,
      });
      // Re-dispatch through `entry()`, exactly as a later call would: it
      // reconnects, or reads the pinned-unavailable state the budget left. This
      // is pool-internal re-dispatch, not an agent dispatch-tier retry.
      const replacement = await entry(serverId, workdir);
      if (replacement === undefined) return unavailableForHop(serverId);
      // Retried once and only once: whatever this attempt returns is the answer,
      // so a second exit cannot buy a third dispatch.
      const retried = await attemptOf(request(replacement.connection));
      if (retried.ok) return retried.result;
      return rejectionResult(serverId, retried.error, opts.servers[serverId]);
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
          // The connect-time pid, not the live getter: a connection that exited
          // while this close was settling would read null and leak its
          // registration (B1).
          const { connection, pid } = result.value;
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
