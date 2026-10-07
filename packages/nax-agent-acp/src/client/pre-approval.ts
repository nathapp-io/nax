/**
 * Adapter pre-approval of embedder tools (S4 spec R12, §6.6; D4-a). Claude's
 * adapter (claude-agent-acp 0.85.1) keys an ACP MCP server by its `name` and
 * passes `_meta.claudeCode.options` through to the Claude Agent SDK, whose
 * `allowedTools` rules allow a tool without a permission request. One exact rule
 * per tool, `mcp__nax__<tool>`, so only the session's own tools are allowed. Tool
 * names are already restricted by the facade, so a rule never needs escaping.
 * Under none/read the entry's read-only enforcement adds the removed tools and its
 * session options (#2366).
 */
import type { AgentRegistryEntry, ReadOnlyEnforcement } from "#src/client/registry";

/** The ACP MCP server name; the agent sees the tools as `mcp__nax__<tool>`. */
export const TOOL_HOST_SERVER_NAME = "nax";

export function mcpToolRule(toolName: string): string {
  return `mcp__${TOOL_HOST_SERVER_NAME}__${toolName}`;
}

/** The session/new, resume and load `_meta` for Claude: tool rules and the read-only enforcement; undefined when empty. */
export function claudeSessionMeta(
  kind: AgentRegistryEntry["preApproval"],
  toolNames: readonly string[],
  readOnly: ReadOnlyEnforcement | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (kind !== "claudeCode.allowedTools") return undefined;
  const options = {
    ...(toolNames.length === 0 ? {} : { allowedTools: toolNames.map(mcpToolRule) }),
    ...(readOnly === undefined ? {} : { disallowedTools: [...readOnly.disallowedTools], ...readOnly.sessionOptions }),
  };
  return Object.keys(options).length === 0 ? undefined : { claudeCode: { options } };
}
