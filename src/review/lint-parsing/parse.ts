import { lintDiagnosticToFinding } from "../../findings";
import { biomeJsonStrategy } from "./strategies/biome-json";
import { eslintJsonStrategy } from "./strategies/eslint-json";
import { textBlockStrategy } from "./strategies/text-block";
import type { LintDiagnostic, LintOutputFormat, LintParseResult, LintParseStrategy, LintParserFormat } from "./types";

function strategiesFor(format: LintOutputFormat): ReadonlyArray<LintParseStrategy> {
  if (format === "eslint-json") return [eslintJsonStrategy];
  if (format === "biome-json") return [biomeJsonStrategy];
  if (format === "text") return [textBlockStrategy];
  if (format === "none") return [];
  return [eslintJsonStrategy, biomeJsonStrategy, textBlockStrategy];
}

function toolForFormat(format: LintParserFormat): "biome" | "eslint" | "text" {
  if (format === "biome-json") return "biome";
  if (format === "eslint-json") return "eslint";
  return "text";
}

export function parseLintOutput(
  output: string,
  format: LintOutputFormat = "auto",
  opts?: { workdir?: string; cwd?: string },
): LintParseResult | null {
  if (!output.trim()) return null;
  const { workdir, cwd } = opts ?? {};
  for (const strategy of strategiesFor(format)) {
    const parsed = strategy.parse(output);
    if (parsed && parsed.diagnostics.length > 0) {
      if (workdir && cwd) {
        const tool = toolForFormat(parsed.format);
        const findings = parsed.diagnostics.map((d) => lintDiagnosticToFinding(d, workdir, cwd, tool));
        return { ...parsed, findings };
      }
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
