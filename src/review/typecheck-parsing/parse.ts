import { typecheckTextBlockStrategy } from "./strategies/text-block";
import { tscStrategy } from "./strategies/tsc";
import type { TypecheckDiagnostic, TypecheckOutputFormat, TypecheckParseResult, TypecheckParseStrategy } from "./types";

function strategiesFor(format: TypecheckOutputFormat): ReadonlyArray<TypecheckParseStrategy> {
  if (format === "tsc") return [tscStrategy];
  if (format === "text") return [typecheckTextBlockStrategy];
  if (format === "none") return [];
  return [tscStrategy, typecheckTextBlockStrategy];
}

export function parseTypecheckOutput(
  output: string,
  format: TypecheckOutputFormat = "auto",
): TypecheckParseResult | null {
  if (!output.trim()) return null;
  for (const strategy of strategiesFor(format)) {
    const parsed = strategy.parse(output);
    if (parsed && parsed.diagnostics.length > 0) {
      return parsed;
    }
  }
  return null;
}

export function formatTypecheckDiagnosticsOutput(diagnostics: readonly TypecheckDiagnostic[]): string | null {
  if (diagnostics.length === 0) return null;
  return (
    diagnostics
      .map((d) => d.raw)
      .join("\n\n")
      .trim() || null
  );
}
