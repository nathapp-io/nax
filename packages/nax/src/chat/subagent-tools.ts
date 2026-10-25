/**
 * Subagent tool-name translation (chat-subagents US-004).
 *
 * Turns a Claude Code agent's `tools:` list into the `allowedTools` list the
 * subagent session admits. Pure and cost-blind. A Claude Code tool pattern such
 * as `Bash(git diff:*)` is not enforced: the entry grants the whole tool and the
 * guarded asks still apply to every call.
 */

export interface DroppedSubagentTool {
  name: string;
  reason: string;
}

export interface MappedSubagentTools {
  /** Absent when the agent declared no `tools:` (inherit every parent tool). */
  allowedTools?: string[];
  dropped: DroppedSubagentTool[];
}

const REASON_NESTED = "subagents cannot start subagents";
const REASON_UNKNOWN = "no nax equivalent";
const MCP_PREFIX = "mcp__";
const MCP_SEPARATOR = "__";

/** Claude Code tool name -> nax tool name; a missing key means "not a direct translation". */
const DIRECT_TOOLS: ReadonlyMap<string, string> = new Map([
  ["Read", "Read"],
  ["Write", "Write"],
  ["Edit", "Edit"],
  ["Bash", "Bash"],
  ["Glob", "Glob"],
  ["Grep", "Grep"],
  ["Git", "Git"],
  ["Delete", "Delete"],
  ["GitCommit", "GitCommit"],
  ["MultiEdit", "Edit"],
  ["Skill", "nax-skills__*"],
]);

const NESTING_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** `Bash(git diff:*)` -> `Bash`; an entry without a trailing `(...)` is returned as is. */
function bareName(entry: string): string {
  const open = entry.indexOf("(");
  return open > 0 && entry.endsWith(")") ? entry.slice(0, open) : entry;
}

/** `mcp__<server>__<tool>` -> `<server>__<tool>`; `mcp__<server>` -> `<server>__*`. */
function mapMcp(name: string): string | undefined {
  const rest = name.slice(MCP_PREFIX.length);
  if (rest.length === 0) return undefined;
  return rest.includes(MCP_SEPARATOR) ? rest : `${rest}${MCP_SEPARATOR}*`;
}

function mapEntry(entry: string): { tool: string } | { reason: string } {
  const name = bareName(entry);
  if (NESTING_TOOLS.has(name)) return { reason: REASON_NESTED };
  const direct = DIRECT_TOOLS.get(name);
  if (direct !== undefined) return { tool: direct };
  if (name.startsWith(MCP_PREFIX)) {
    const mcp = mapMcp(name);
    if (mcp !== undefined) return { tool: mcp };
  }
  return { reason: REASON_UNKNOWN };
}

export function mapSubagentTools(tools: readonly string[] | undefined): MappedSubagentTools {
  if (tools === undefined) return { dropped: [] };
  const allowed = new Set<string>();
  const dropped: DroppedSubagentTool[] = [];
  for (const entry of tools) {
    const mapped = mapEntry(entry);
    if ("tool" in mapped) allowed.add(mapped.tool);
    else dropped.push({ name: entry, reason: mapped.reason });
  }
  return { allowedTools: [...allowed], dropped };
}
