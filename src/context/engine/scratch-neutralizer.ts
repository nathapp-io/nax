/**
 * Context Engine v2 — Cross-Agent Scratch Neutralizer (AC-42)
 *
 * Strips or generalizes agent-specific tool-name references from scratch
 * entry free-text fields when the content was written by one agent and is
 * being read by a different one.
 *
 * Only Claude-originated tool names are substituted today (Claude Code is
 * the primary writer). Non-claude source agents pass through unchanged.
 *
 * Pure function — no I/O. Called from SessionScratchProvider.renderEntry().
 *
 * See: docs/specs/SPEC-context-engine-v2.md §AC-42
 */

// ─────────────────────────────────────────────────────────────────────────────
// Substitution table for Claude Code tool names
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_TOOL_SUBSTITUTIONS: [RegExp, string][] = [
  [/\bthe\s+Read\s+tool\b/gi, "a file read"],
  [/\bthe\s+Edit\s+tool\b/gi, "a file edit"],
  [/\bthe\s+Write\s+tool\b/gi, "a file write"],
  [/\bthe\s+Bash\s+tool\b/gi, "a shell command"],
  [/\bthe\s+Grep\s+tool\b/gi, "a code search"],
  [/\bthe\s+Glob\s+tool\b/gi, "a file search"],
  [/\bthe\s+Agent\s+tool\b/gi, "a sub-agent"],
  [/\bthe\s+Task\s+tool\b/gi, "a sub-agent"],
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Neutralize agent-specific tool references in scratch content.
 *
 * When sourceAgent === targetAgent (or either is empty), the content is
 * returned unchanged — same-agent reads never need neutralization.
 *
 * When sourceAgent is "claude" and targetAgent differs, Claude Code tool
 * name patterns (e.g. "the Read tool") are replaced with generic equivalents.
 *
 * Non-claude source agents are left unchanged — only Claude's tool names
 * are known to appear in outputTail content today.
 *
 * @param content     - free-text content to neutralize
 * @param sourceAgent - agent id that originally wrote the content
 * @param targetAgent - agent id that will read the content
 */
export function neutralizeForAgent(content: string, sourceAgent: string, targetAgent: string): string {
  if (!content || !sourceAgent || !targetAgent || sourceAgent === targetAgent) return content;
  if (sourceAgent.toLowerCase() !== "claude") return content;

  let result = content;
  for (const [pattern, replacement] of CLAUDE_TOOL_SUBSTITUTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
