import type { ReviewFinding } from "../../plugins/types";
import type { Finding } from "../types";

/**
 * Convert a ReviewFinding from the IReviewPlugin contract to the canonical Finding wire format.
 *
 * Plugin contract (ReviewFinding) is workdir-relative — no path rebasing needed.
 * workdir is accepted for API consistency with other adapters (phases 3+) but unused here.
 */
export function pluginToFinding(rf: ReviewFinding, _workdir: string): Finding {
  return {
    source: "plugin",
    tool: rf.source ?? "plugin",
    severity: rf.severity,
    category: rf.category ?? "general",
    rule: rf.ruleId,
    file: rf.file,
    line: rf.line,
    column: rf.column,
    endLine: rf.endLine,
    endColumn: rf.endColumn,
    message: rf.message,
    meta: rf.url ? { url: rf.url } : undefined,
  };
}
