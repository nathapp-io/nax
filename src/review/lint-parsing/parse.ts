import { biomeJsonStrategy } from "./strategies/biome-json";
import { eslintJsonStrategy } from "./strategies/eslint-json";
import { textBlockStrategy } from "./strategies/text-block";
import type { LintDiagnostic, LintOutputFormat, LintParseResult, LintParseStrategy } from "./types";

function strategiesFor(format: LintOutputFormat): ReadonlyArray<LintParseStrategy> {
  if (format === "eslint-json") return [eslintJsonStrategy];
  if (format === "biome-json") return [biomeJsonStrategy];
  if (format === "text") return [textBlockStrategy];
  if (format === "none") return [];
  return [eslintJsonStrategy, biomeJsonStrategy, textBlockStrategy];
}

export function parseLintOutput(output: string, format: LintOutputFormat = "auto"): LintParseResult | null {
  if (!output.trim()) return null;
  for (const strategy of strategiesFor(format)) {
    const parsed = strategy.parse(output);
    if (parsed && parsed.diagnostics.length > 0) {
      return parsed;
    }
  }
  return null;
}

export function filterDiagnosticsByFiles(
  diagnostics: readonly LintDiagnostic[],
  files: ReadonlySet<string>,
): LintDiagnostic[] {
  return diagnostics.filter((d) => files.has(d.file));
}

export function formatDiagnosticsOutput(diagnostics: readonly LintDiagnostic[]): string | null {
  if (diagnostics.length === 0) return null;
  return (
    diagnostics
      .map((d) => d.raw)
      .join("\n\n")
      .trim() || null
  );
}
