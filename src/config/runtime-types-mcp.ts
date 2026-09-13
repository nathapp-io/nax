/**
 * `mcp` config types — external MCP servers (client only; nax is never a server).
 *
 * Split out of `runtime-types.ts`, which is at its file-size limit.
 */

export type McpStage =
  | "plan"
  | "run"
  | "setup"
  | "verify"
  | "review"
  | "rectification"
  | "regression"
  | "acceptance"
  | "complete"
  | "*";

export interface McpServerConfig {
  /** Executable spawned over stdio. */
  command: string;
  args: string[];
  /** Overlaid on the inherited environment; never replaces PATH wholesale. */
  env: Record<string, string>;
  /** Pipeline stages this server attaches to; `["*"]` is every stage. */
  stages: McpStage[];
  /** Optional narrowing; omitted means every locked tool is grantable. */
  allowedTools?: string[];
  /** Per-call timeout in ms. */
  timeoutMs: number;
  enabled: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}
