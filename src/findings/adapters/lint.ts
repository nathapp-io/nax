import type { LintDiagnostic } from "../../review/lint-parsing/types";
import { rebaseToWorkdir } from "../path-utils";
import type { Finding } from "../types";

export function lintDiagnosticToFinding(
  d: LintDiagnostic,
  workdir: string,
  cwd: string,
  tool: "biome" | "eslint" | "text",
): Finding {
  return {
    source: "lint",
    tool,
    severity: d.severity ?? "warning",
    category: "lint",
    rule: d.ruleId,
    file: rebaseToWorkdir(d.file, cwd, workdir),
    line: d.line,
    column: d.column,
    message: d.message,
  };
}
