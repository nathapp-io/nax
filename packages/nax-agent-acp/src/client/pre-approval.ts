/**
 * Adapter pre-approval of embedder tools (S4 spec R12, §6.6; D4-a). Claude's
 * adapter (claude-agent-acp 0.85.1) keys an ACP MCP server by its `name` and
 * passes `_meta.claudeCode.options` through to the Claude Agent SDK, whose
 * `allowedTools` rules allow a tool without a permission request. One exact rule
 * per tool, `mcp__nax__<tool>`, so only the session's own tools are allowed. Tool
 * names are already restricted by the facade, so a rule never needs escaping.
 * Plan mode (profiles none/read) asks before any MCP tool not marked read-only,
 * ahead of these rules; tool-calls.ts lists every tool with readOnlyHint (#2365).
 */
import type { AgentRegistryEntry } from "#src/client/registry";

/** The ACP MCP server name; the agent sees the tools as `mcp__nax__<tool>`. */
export const TOOL_HOST_SERVER_NAME = "nax";

export function mcpToolRule(toolName: string): string {
  return `mcp__${TOOL_HOST_SERVER_NAME}__${toolName}`;
}

/** The session/new `_meta` that pre-approves the tools, or undefined when the agent has no mechanism. */
export function preApprovalMeta(
  kind: AgentRegistryEntry["preApproval"],
  toolNames: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (kind !== "claudeCode.allowedTools") return undefined;
  return { claudeCode: { options: { allowedTools: toolNames.map(mcpToolRule) } } };
}
