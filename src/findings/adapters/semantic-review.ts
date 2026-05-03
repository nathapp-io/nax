import type { ReviewFinding } from "../../plugins/types";
import type { Finding } from "../types";

/** Convert a persisted ReviewFinding (semantic check) to the unified Finding wire format. */
export function reviewFindingToFinding(f: ReviewFinding): Finding {
  return {
    source: "semantic-review",
    severity: f.severity,
    category: f.category ?? "",
    rule: f.ruleId,
    file: f.file,
    line: f.line,
    column: f.column,
    endLine: f.endLine,
    endColumn: f.endColumn,
    message: f.message,
    fixTarget: "source",
  };
}
