/**
 * One stdio MCP connection, adapted from the shared layer (`@nathapp/nax-agent/mcp`).
 *
 * The env-overlay and piped-stderr traps now live in the shared layer (S5-5a):
 * it overlays the SDK's default environment (keeps `PATH`) and pipes stderr with
 * a bounded tail, so a server's diagnostics never interleave with nax's TUI.
 * This file adds only what nax run needs on top: nax's own connection vocabulary
 * (`serverId`/`workdir`/`pid`/`listTools`/`callTool` with `bytesPreTruncation`),
 * a hard byte ceiling on call results (the shared renderer may append a
 * truncation notice past the cap), and the `NaxError` wrap for connect failures.
 */
import {
  type ConnectMcpOptions,
  connectMcp as connectSharedMcp,
  type McpTransportConfig,
} from "@nathapp/nax-agent/mcp";
import { NaxError } from "@/errors";
import type { McpConnection } from "./types";

/** Injectable seam (mirrors the ACP bridge's `connect` dep): unit tests fake the shared layer here. */
export const _mcpClientDeps: { connect: typeof connectSharedMcp } = { connect: connectSharedMcp };

/** Truncate to a byte ceiling without splitting a code point (mirrors provider-sanitize). */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return out;
}

export async function connectMcpServer(args: {
  serverId: string;
  workdir: string;
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  connectTimeoutMs: number;
}): Promise<McpConnection> {
  const config: McpTransportConfig = {
    kind: "stdio",
    command: args.command,
    args: args.args,
    env: args.env,
    cwd: args.workdir,
  };
  const opts: ConnectMcpOptions = {
    // No cancellation source in nax run; connect is bounded by timeoutMs.
    signal: new AbortController().signal,
    timeoutMs: args.connectTimeoutMs,
    clientInfo: { name: "nax", version: "1" },
  };
  const shared = await _mcpClientDeps.connect(config, opts).catch((error: unknown) => {
    throw new NaxError(
      `MCP server "${args.serverId}" failed to connect at ${args.workdir}: ${String(error)}`,
      "MCP_CONNECT_FAILED",
      { stage: "tools", cause: error },
    );
  });
  return {
    serverId: args.serverId,
    workdir: args.workdir,
    get pid() {
      return shared.pid;
    },
    // `McpToolInfo` is structurally identical to `McpToolDescriptor` (the same
    // `JSONSchema` re-export); the shared layer fetched every tools/list page at
    // connect.
    listTools() {
      return Promise.resolve(shared.tools);
    },
    async callTool(name, input, callOpts) {
      const result = await shared.call(name, input, {
        // SDK-level cancellation under the pool's own deadline race (pool.ts MEM-5).
        signal: AbortSignal.timeout(callOpts.timeoutMs),
        timeoutMs: callOpts.timeoutMs,
        maxBytes: callOpts.maxBytes,
      });
      return {
        content: truncateToBytes(result.text, callOpts.maxBytes),
        isError: result.isError,
        bytesPreTruncation: result.bytesBeforeCap,
      };
    },
    close: () => shared.close(),
  };
}
