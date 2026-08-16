/**
 * Shared diagnostic-rendering helper for the context engine.
 *
 * Both `ToolDiagnosticsProvider` (push path) and `handleQueryScratch`
 * (pull path, `tool-diagnostics` case) used to build the same
 * `file:line:col [tool] (rule) — message` Markdown shape independently,
 * with one already drifting (query-scratch added `<unknown>` and explicit
 * row-handling). Extracting this helper is the ENH-5 fix in
 * docs/20260816-review-since-0.80.0-canary.3.md — a single source of
 * truth so push and pull render the same shape for the same input.
 */

export interface DiagnosticLike {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  severity?: string;
  tool?: string;
  rule?: string;
}

/**
 * Format one diagnostic as a single Markdown bullet line.
 *
 * Output layout (stable for snapshot tests / prompt templates):
 *
 *   - **<severity>** <file>:<line>:<column> [<tool>] (<rule>) — <message>
 *
 * Defaults:
 *   - `severity` defaults to `error` when absent.
 *   - `file` falls back to `<unknown>` so a raw-tail diagnostic (no
 *     structured file/line) still produces a syntactically valid line.
 *   - `line`/`column`/`tool`/`rule` are each omitted cleanly when absent.
 */
export function formatDiagnostic(d: DiagnosticLike): string {
  const where = d.file
    ? `${d.file}${d.line !== undefined ? `:${d.line}` : ""}${d.column !== undefined ? `:${d.column}` : ""}`
    : "<unknown>";
  const rule = d.rule ? ` (${d.rule})` : "";
  const tool = d.tool ? ` [${d.tool}]` : "";
  return `- **${d.severity ?? "error"}** ${where}${tool}${rule} — ${d.message}`;
}
