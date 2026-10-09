/** Errors of the shared MCP layer (S5-5 spec §3.1, plan M-42). */
import { NaxError } from "#src/infra/nax-error";

export class McpConnectError extends NaxError {
  constructor(
    message: string,
    public readonly stderrTail?: string,
    context: Record<string, unknown> = {},
  ) {
    super(message, "MCP_CONNECT_FAILED", context);
    this.name = "McpConnectError";
  }
}

export class McpCallError extends NaxError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, "MCP_CALL_FAILED", context);
    this.name = "McpCallError";
  }
}
