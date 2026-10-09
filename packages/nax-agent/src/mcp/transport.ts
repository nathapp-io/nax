/**
 * The SDK transport for one McpTransportConfig (S5-5 spec §3.1). The only file
 * besides connect.ts that imports the SDK. stdio: the env is an overlay on the
 * SDK's default environment (SDK 1.30.0 already merges; passing it explicitly
 * keeps PATH if a later SDK stops), and stderr is piped with a bounded tail
 * kept for connect-failure messages, never inherited (stdout may carry ACP
 * frames). http: streamable HTTP with the configured headers.
 */
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpTransportConfig } from "#src/mcp/types";

export const STDERR_TAIL_BYTES = 512;

export interface TransportHandle {
  readonly transport: Transport;
  readonly pid: () => number | null;
  readonly stderrTail: () => string;
  /** http: DELETE the MCP session, best effort. */
  readonly terminate?: () => Promise<void>;
}

function stdioHandle(config: Extract<McpTransportConfig, { kind: "stdio" }>): TransportHandle {
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...config.args],
    env: { ...getDefaultEnvironment(), ...config.env },
    cwd: config.cwd,
    stderr: "pipe",
  });
  let tail = Buffer.alloc(0);
  transport.stderr?.on("data", (chunk: Buffer) => {
    const joined = Buffer.concat([tail, chunk]);
    tail = joined.subarray(Math.max(0, joined.length - STDERR_TAIL_BYTES));
  });
  return { transport, pid: () => transport.pid, stderrTail: () => tail.toString("utf8") };
}

function httpHandle(config: Extract<McpTransportConfig, { kind: "http" }>): TransportHandle {
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { ...config.headers } },
  });
  return {
    transport,
    pid: () => null,
    stderrTail: () => "",
    terminate: () => transport.terminateSession().catch(() => undefined),
  };
}

/** Injectable seam: unit tests return an in-memory transport. */
export const _mcpTransportDeps = {
  create: (config: McpTransportConfig): TransportHandle =>
    config.kind === "stdio" ? stdioHandle(config) : httpHandle(config),
};
