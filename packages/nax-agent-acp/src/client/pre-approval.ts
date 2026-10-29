/**
 * Adapter pre-approval of embedder tools (S4 spec R12, §6.6; D4-a). Claude's
 * adapter (claude-agent-acp 0.85.1) keys an ACP MCP server by its `name` and
 * passes `_meta.claudeCode.options` through to the Claude Agent SDK, whose
 * `allowedTools` rules allow a tool without a permission request. One exact rule
 * per tool, `mcp__<serverName>__<tool>` (the session's `nax-<8 hex>` name), so only the session's own tools are allowed. Tool
 * names are already restricted by the facade, so a rule never needs escaping.
 * Under none/read the entry's read-only enforcement adds the removed tools and its
 * session options (#2366).
 */
import type { SandboxPolicy } from "@nathapp/nax-agent";
import { claudeSandboxOptions } from "#src/client/claude-sandbox";
import type { AgentRegistryEntry, ReadOnlyEnforcement } from "#src/client/registry";

/**
 * The prefix of the ACP MCP server name. Each session's name is `nax-<8 hex>`
 * (`newToolHostServerName`), so the agent sees its tools as
 * `mcp__nax-<8 hex>__<tool>`; the MCP `initialize` `serverInfo` name stays `nax`.
 */
export const TOOL_HOST_SERVER_NAME = "nax";

const AGENT_TOOL_NAME = /^mcp__nax-[0-9a-f]{8}__(.+)$/s;

export function mcpToolRule(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** The tool name behind an agent-visible `mcp__nax-<8 hex>__<tool>`; undefined for any other name. */
export function parseToolHostToolName(name: string): string | undefined {
  return AGENT_TOOL_NAME.exec(name)?.[1];
}

export interface ClaudeMetaExtras {
  /** nax#2500: the session sandbox (profiles review and full). */
  readonly sandbox?: SandboxPolicy;
  /** nax#2500: profile full pins allowDangerouslySkipPermissions false. */
  readonly lockSkipPermissions?: boolean;
}

/** The session/new, resume and load `_meta` for Claude: tool rules and the read-only enforcement; undefined when empty. */
export function claudeSessionMeta(
  kind: AgentRegistryEntry["preApproval"],
  serverName: string,
  toolNames: readonly string[],
  readOnly: ReadOnlyEnforcement | undefined,
  extras: ClaudeMetaExtras = {},
): Readonly<Record<string, unknown>> | undefined {
  if (kind !== "claudeCode.allowedTools") return undefined;
  const options = {
    ...(toolNames.length === 0 ? {} : { allowedTools: toolNames.map((tool) => mcpToolRule(serverName, tool)) }),
    ...(readOnly === undefined ? {} : { disallowedTools: [...readOnly.disallowedTools], ...readOnly.sessionOptions }),
    ...(extras.sandbox === undefined ? {} : { sandbox: claudeSandboxOptions(extras.sandbox) }),
    ...(extras.lockSkipPermissions === true ? { allowDangerouslySkipPermissions: false } : {}),
  };
  return Object.keys(options).length === 0 ? undefined : { claudeCode: { options } };
}
