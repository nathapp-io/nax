export type TypecheckOutputFormat = "auto" | "tsc" | "text" | "none";

export type TypecheckParserFormat = "tsc" | "text-block";

export interface TypecheckDiagnostic {
  file: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  raw: string;
}

export interface TypecheckParseResult {
  diagnostics: TypecheckDiagnostic[];
  format: TypecheckParserFormat;
}

export interface TypecheckParseStrategy {
  readonly name: TypecheckParserFormat;
  parse(output: string): TypecheckParseResult | null;
}
