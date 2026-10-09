/**
 * connectMcp (S5-5 spec §3.1): one MCP server over stdio or streamable HTTP.
 * Connect (initialize + every tools/list page) is bounded by timeoutMs and the
 * caller's signal; a call honours its signal and timeout (reset on progress);
 * close is idempotent, bounded by closeGraceMs, and for stdio resolves only
 * once the process is gone. A failed connect is closed the same way.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpCallError, McpConnectError } from "#src/mcp/errors";
import { resultText } from "#src/mcp/result-text";
import { waitForStdioExit } from "#src/mcp/stdio-close";
import { _mcpTransportDeps, type TransportHandle } from "#src/mcp/transport";
import type { ConnectMcpOptions, McpCallOptions, McpConnection, McpToolInfo, McpTransportConfig } from "#src/mcp/types";
import type { JSONSchema } from "#src/session/tool-descriptor";

export const DEFAULT_CLOSE_GRACE_MS = 3000;
const EXIT_REASON = "the server process exited";

type Raw = Readonly<Record<string, unknown>>;
const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Waits for `promise` at most `ms`; the timer is cleared, so nothing keeps the process alive. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise.catch(() => undefined), limit]);
  clearTimeout(timer);
}

/** Process-exit bookkeeping for one connection. stdio only reports an exit nobody asked for. */
interface Life {
  exited: boolean;
  closing: boolean;
  exitReason: string | undefined;
  readonly listeners: ((reason: string) => void)[];
}

function trackLife(client: Client, kind: McpTransportConfig["kind"]): Life {
  const life: Life = { exited: false, closing: false, exitReason: undefined, listeners: [] };
  client.onclose = () => {
    life.exited = true;
    if (life.closing || kind !== "stdio" || life.exitReason !== undefined) return;
    life.exitReason = EXIT_REASON;
    for (const listener of life.listeners) listener(EXIT_REASON);
  };
  return life;
}

async function closeTransport(client: Client, handle: TransportHandle, graceMs: number, life: Life): Promise<void> {
  life.closing = true;
  const pid = handle.pid();
  if (handle.terminate !== undefined) await within(handle.terminate(), graceMs);
  const closed = client.close();
  if (pid === null) return within(closed, graceMs);
  await waitForStdioExit(pid, () => life.exited, graceMs);
}

function toolInfo(raw: unknown): McpToolInfo | undefined {
  if (!isRaw(raw) || typeof raw.name !== "string" || raw.name.length === 0) return undefined;
  const inputSchema: JSONSchema = isRaw(raw.inputSchema) ? { ...raw.inputSchema } : {};
  return { name: raw.name, description: typeof raw.description === "string" ? raw.description : "", inputSchema };
}

async function listAll(client: Client, signal: AbortSignal, timeout: number): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor !== undefined ? { cursor } : undefined, { signal, timeout });
    for (const raw of page.tools ?? []) {
      const info = toolInfo(raw);
      if (info !== undefined) tools.push(info);
    }
    cursor = typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return tools;
}

function connectFailure(error: unknown, deadline: AbortSignal, opts: ConnectMcpOptions, handle: TransportHandle) {
  const timedOut = deadline.aborted || (error instanceof McpError && error.code === ErrorCode.RequestTimeout);
  const reason = timedOut ? `timed out after ${opts.timeoutMs} ms` : messageOf(error);
  const tail = handle.stderrTail().trim();
  return new McpConnectError(`MCP connect failed: ${reason}`, tail === "" ? undefined : tail);
}

function createHandle(config: McpTransportConfig): TransportHandle {
  try {
    return _mcpTransportDeps.create(config);
  } catch (error) {
    throw new McpConnectError(`MCP connect failed: ${messageOf(error)}`);
  }
}

export async function connectMcp(config: McpTransportConfig, opts: ConnectMcpOptions): Promise<McpConnection> {
  const handle = createHandle(config);
  const client = new Client({ name: opts.clientInfo.name, version: opts.clientInfo.version });
  const graceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const life = trackLife(client, config.kind);
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  const signal = AbortSignal.any([opts.signal, deadline]);
  try {
    if (signal.aborted) throw new McpConnectError("MCP connect failed: aborted");
    await client.connect(handle.transport, { signal, timeout: opts.timeoutMs });
    const tools = await listAll(client, signal, opts.timeoutMs);
    return liveConnection(config, client, handle, tools, { graceMs, life });
  } catch (error) {
    await closeTransport(client, handle, graceMs, life);
    throw error instanceof McpConnectError ? error : connectFailure(error, deadline, opts, handle);
  }
}

async function callTool(client: Client, name: string, input: unknown, opts: McpCallOptions) {
  try {
    const raw = await client.callTool({ name, arguments: isRaw(input) ? { ...input } : {} }, undefined, {
      signal: opts.signal,
      timeout: opts.timeoutMs,
      resetTimeoutOnProgress: true,
      // The SDK sends a progressToken (so servers can report progress and reset
      // the timeout) only when onprogress is set (shared/protocol.js:643-650).
      onprogress: () => undefined,
    });
    return resultText(raw, opts.maxBytes);
  } catch (error) {
    throw new McpCallError(`MCP call ${name} failed: ${messageOf(error)}`);
  }
}

function liveConnection(
  config: McpTransportConfig,
  client: Client,
  handle: TransportHandle,
  tools: readonly McpToolInfo[],
  state: { readonly graceMs: number; readonly life: Life },
): McpConnection {
  let closing: Promise<void> | undefined;
  const { life } = state;
  return {
    kind: config.kind,
    tools,
    call(name, input, opts) {
      if (closing !== undefined || life.exited)
        return Promise.reject(new McpCallError(`MCP call ${name} failed: the connection is closed`));
      return callTool(client, name, input, opts);
    },
    onClose(listener) {
      // An exit before anyone listened (spec §4.5, plan review I3) is still reported, once.
      if (life.exitReason !== undefined) listener(life.exitReason);
      else life.listeners.push(listener);
    },
    close() {
      closing ??= closeTransport(client, handle, state.graceMs, life);
      return closing;
    },
  };
}
