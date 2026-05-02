import type { TypecheckDiagnostic } from "../../review/typecheck-parsing/types";
import { rebaseToWorkdir } from "../path-utils";
import type { Finding } from "../types";

export function tscDiagnosticToFinding(d: TypecheckDiagnostic, workdir: string): Finding {
  return {
    source: "typecheck",
    tool: "tsc",
    severity: "error",
    category: "type-error",
    rule: d.code ? `TS${d.code}` : undefined,
    file: rebaseToWorkdir(d.file, workdir, workdir),
    line: d.line,
    column: d.column,
    message: d.message,
  };
}
