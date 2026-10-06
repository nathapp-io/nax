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
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import type { AgentRegistryEntry } from "#src/client/registry";

/** The ACP MCP server name; the agent sees the tools as `mcp__nax__<tool>`. */
export const TOOL_HOST_SERVER_NAME = "nax";

export function mcpToolRule(toolName: string): string {
  return `mcp__${TOOL_HOST_SERVER_NAME}__${toolName}`;
}

/**
 * Claude tools a session under `none` or `read` never gets (#2365). Asked to change
 * something in plan mode, Claude calls ExitPlanMode; the adapter turns its reject into
 * an interrupt, so the turn ended ACP_STOP_CANCELLED instead of meeting the profile's
 * refusal. Without it Claude reaches for Write or Edit, which layer 2 rejects.
 */
export const READ_ONLY_DISALLOWED_TOOLS: readonly string[] = Object.freeze(["ExitPlanMode"]);

/** The session/new, resume and load `_meta` for Claude: tool rules and the read-only lock; undefined when empty. */
export function claudeSessionMeta(
  kind: AgentRegistryEntry["preApproval"],
  toolNames: readonly string[],
  profile: AgentSessionProfile,
): Readonly<Record<string, unknown>> | undefined {
  if (kind !== "claudeCode.allowedTools") return undefined;
  const options = {
    ...(toolNames.length === 0 ? {} : { allowedTools: toolNames.map(mcpToolRule) }),
    ...(profile === "none" || profile === "read" ? { disallowedTools: [...READ_ONLY_DISALLOWED_TOOLS] } : {}),
  };
  return Object.keys(options).length === 0 ? undefined : { claudeCode: { options } };
}
