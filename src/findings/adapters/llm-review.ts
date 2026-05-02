import type { LlmReviewFinding } from "../../operations/types";
import { rebaseToWorkdir } from "../path-utils";
import type { Finding, FindingSeverity } from "../types";

function normalizeSeverity(sev: string): FindingSeverity {
  if (sev === "warn") return "warning";
  if (
    sev === "critical" ||
    sev === "error" ||
    sev === "warning" ||
    sev === "info" ||
    sev === "low" ||
    sev === "unverifiable"
  )
    return sev;
  return "info";
}

export function llmReviewFindingToFinding(lf: LlmReviewFinding, workdir: string): Finding {
  return {
    source: "adversarial-review",
    severity: normalizeSeverity(lf.severity),
    category: lf.category ?? "",
    file: rebaseToWorkdir(lf.file, workdir, workdir),
    line: lf.line,
    message: lf.issue,
    suggestion: lf.suggestion,
  };
}
