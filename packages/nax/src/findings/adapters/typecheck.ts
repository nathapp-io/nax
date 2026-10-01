import type { TypecheckDiagnostic } from "@/review/typecheck-parsing/types";
import { rebaseToWorkdir } from "../path-utils";
import type { Finding } from "../types";

export function genericTypecheckDiagnosticToFinding(d: TypecheckDiagnostic, workdir: string, tool?: string): Finding {
  return {
    source: "typecheck",
    tool,
    severity: "error",
    category: "type-error",
    rule: d.code ? `TS${d.code}` : undefined,
    file: rebaseToWorkdir(d.file, workdir, workdir),
    line: d.line,
    column: d.column,
    message: d.message,
    fixTarget: "source",
  };
}
