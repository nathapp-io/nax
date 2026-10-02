import type { ToolGrant } from "./types";

/**
 * Parse one #374 tool expression.
 *
 * `Read`                  -> unconditional
 * `Write(src/**,test/**)` -> those two globs
 * `Git(diff,log)`         -> those two subcommands
 */
export function parseToolExpression(expression: string): ToolGrant {
  const open = expression.indexOf("(");
  if (open === -1) return { tool: expression.trim(), patterns: ["*"] };
  const tool = expression.slice(0, open).trim();
  const inner = expression.slice(open + 1, expression.lastIndexOf(")"));
  const patterns = inner
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { tool, patterns: patterns.length > 0 ? patterns : ["*"] };
}

/** Parse a list of rule expressions into grants. Effect is carried by which
 * config list (allow/deny/ask) the expressions came from, not by the grant. */
export function parseRuleList(expressions: readonly string[]): ToolGrant[] {
  return expressions.map(parseToolExpression);
}
