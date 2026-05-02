import type { Finding } from "../../findings";

export type LintOutputFormat = "auto" | "eslint-json" | "biome-json" | "text" | "none";

export type LintParserFormat = "eslint-json" | "biome-json" | "text-block";

export interface LintDiagnostic {
  file: string;
  line?: number;
  column?: number;
  severity?: "error" | "warning" | "info";
  ruleId?: string;
  message: string;
  raw: string;
}

export interface LintParseResult {
  diagnostics: LintDiagnostic[];
  format: LintParserFormat;
  /** Structured findings (ADR-021 phase 3). Populated when workdir/cwd are provided to parseLintOutput(). */
  findings?: Finding[];
}

export interface LintParseStrategy {
  readonly name: LintParserFormat;
  parse(output: string): LintParseResult | null;
}
