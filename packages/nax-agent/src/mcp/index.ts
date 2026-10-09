/**
 * `@nathapp/nax-agent/mcp`: the shared MCP connection layer (S5-5 spec §3.1).
 * Never imported from the root entry, so `@nathapp/nax-agent` alone never loads
 * the MCP SDK.
 */
export { connectMcp, DEFAULT_CLOSE_GRACE_MS } from "#src/mcp/connect";
export { McpCallError, McpConnectError } from "#src/mcp/errors";
export { resultText } from "#src/mcp/result-text";
export type {
  ConnectMcpOptions,
  McpCallOptions,
  McpCallResult,
  McpConnection,
  McpToolInfo,
  McpTransportConfig,
} from "#src/mcp/types";
