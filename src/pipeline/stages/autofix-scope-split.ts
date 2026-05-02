import {
  type LintDiagnostic,
  type LintOutputFormat,
  formatDiagnosticsOutput,
  parseLintOutput,
} from "../../review/lint-parsing";
import {
  type TypecheckDiagnostic,
  type TypecheckOutputFormat,
  formatTypecheckDiagnosticsOutput,
  parseTypecheckOutput,
} from "../../review/typecheck-parsing";
import type { ReviewCheckResult } from "../../review/types";
import { isTestFile } from "../../test-runners";

/**
 * Extract unique file paths from lint output by running the best-effort parser chain.
 */
export function extractFilesFromLintOutput(output: string, format: LintOutputFormat = "auto"): string[] {
  const parsed = parseLintOutput(output, format);
  if (!parsed) return [];
  return Array.from(new Set(parsed.diagnostics.map((d) => d.file)));
}

function buildScopedLintCheck(
  check: ReviewCheckResult,
  diagnostics: readonly LintDiagnostic[],
): ReviewCheckResult | null {
  const output = formatDiagnosticsOutput(diagnostics);
  if (!output) return null;
  return { ...check, output };
}

function buildScopedTypecheckCheck(
  check: ReviewCheckResult,
  diagnostics: readonly TypecheckDiagnostic[],
): ReviewCheckResult | null {
  const output = formatTypecheckDiagnosticsOutput(diagnostics);
  if (!output) return null;
  return { ...check, output };
}

/**
 * Best-effort block/diagnostic filter for lint output.
 * Returns null when no diagnostics map to target files.
 */
export function filterLintOutputToFiles(
  output: string,
  targetFiles: ReadonlySet<string>,
  format: LintOutputFormat = "text",
): string | null {
  const parsed = parseLintOutput(output, format);
  if (!parsed) return null;
  const filtered = parsed.diagnostics.filter((d) => targetFiles.has(d.file));
  return formatDiagnosticsOutput(filtered);
}

/**
 * Extract unique file paths from typecheck output by running parser strategies.
 */
export function extractFilesFromTypecheckOutput(output: string, format: TypecheckOutputFormat = "auto"): string[] {
  const parsed = parseTypecheckOutput(output, format);
  if (!parsed) return [];
  return Array.from(new Set(parsed.diagnostics.map((d) => d.file)));
}

/**
 * Best-effort block/diagnostic filter for typecheck output.
 * Returns null when no diagnostics map to target files.
 */
export function filterTypecheckOutputToFiles(
  output: string,
  targetFiles: ReadonlySet<string>,
  format: TypecheckOutputFormat = "text",
): string | null {
  const parsed = parseTypecheckOutput(output, format);
  if (!parsed) return null;
  const filtered = parsed.diagnostics.filter((d) => targetFiles.has(d.file));
  return formatTypecheckDiagnosticsOutput(filtered);
}

function splitByStructuredFindings(
  check: ReviewCheckResult,
  testFilePatterns?: readonly string[],
): { testFindings: ReviewCheckResult | null; sourceFindings: ReviewCheckResult | null } {
  if (!check.findings?.length) {
    return { testFindings: null, sourceFindings: null };
  }

  // Issue #829: adversarial `test-gap` findings flag a source-file unit that lacks
  // a test, so `file` points at the source. The remediation is to create a test
  // file — implementer scope cannot satisfy that. Route by category for `test-gap`.
  const isTestScoped = (file: string | undefined, category: string | undefined): boolean =>
    category === "test-gap" || isTestFile(file ?? "", testFilePatterns);

  const testFs = check.findings.filter((f) => isTestScoped(f.file, f.category));
  const sourceFs = check.findings.filter((f) => !isTestScoped(f.file, f.category));

  const toCheck = (findings: typeof testFs): ReviewCheckResult | null => {
    if (findings.length === 0) return null;
    // Preserve the raw tool output -- it may contain structured diagnostics or stack traces
    // that the agent needs for accurate diagnosis. Only `findings` is scoped.
    return { ...check, findings };
  };

  return { testFindings: toCheck(testFs), sourceFindings: toCheck(sourceFs) };
}

function splitByOutputParsing(
  check: ReviewCheckResult,
  testFilePatterns?: readonly string[],
  format: LintOutputFormat = "auto",
): { testFindings: ReviewCheckResult | null; sourceFindings: ReviewCheckResult | null } {
  const parsed = parseLintOutput(check.output, format);
  if (!parsed) {
    // Cannot classify by file -- conservative fallback: route to implementer if output is non-empty
    if (check.output.trim()) {
      return { testFindings: null, sourceFindings: check };
    }
    return { testFindings: null, sourceFindings: null };
  }

  const testDiagnostics = parsed.diagnostics.filter((d) => isTestFile(d.file, testFilePatterns));
  const sourceDiagnostics = parsed.diagnostics.filter((d) => !isTestFile(d.file, testFilePatterns));

  return {
    testFindings: buildScopedLintCheck(check, testDiagnostics),
    sourceFindings: buildScopedLintCheck(check, sourceDiagnostics),
  };
}

function splitByTypecheckOutputParsing(
  check: ReviewCheckResult,
  testFilePatterns?: readonly string[],
  format: TypecheckOutputFormat = "auto",
): { testFindings: ReviewCheckResult | null; sourceFindings: ReviewCheckResult | null } {
  const parsed = parseTypecheckOutput(check.output, format);
  if (!parsed) {
    if (check.output.trim()) {
      return { testFindings: null, sourceFindings: check };
    }
    return { testFindings: null, sourceFindings: null };
  }

  const testDiagnostics = parsed.diagnostics.filter((d) => isTestFile(d.file, testFilePatterns));
  const sourceDiagnostics = parsed.diagnostics.filter((d) => !isTestFile(d.file, testFilePatterns));

  return {
    testFindings: buildScopedTypecheckCheck(check, testDiagnostics),
    sourceFindings: buildScopedTypecheckCheck(check, sourceDiagnostics),
  };
}

/**
 * Split a check result into test-file vs source-file buckets for scope-aware routing.
 * Returns null for each bucket when there are no findings for that scope.
 */
export function splitFindingsByScope(
  check: ReviewCheckResult,
  testFilePatterns?: readonly string[],
  lintOutputFormat: LintOutputFormat = "auto",
  typecheckOutputFormat: TypecheckOutputFormat = "auto",
): {
  testFindings: ReviewCheckResult | null;
  sourceFindings: ReviewCheckResult | null;
} {
  if (check.check === "adversarial") {
    return splitByStructuredFindings(check, testFilePatterns);
  }
  if (check.check === "lint") {
    return splitByOutputParsing(check, testFilePatterns, lintOutputFormat);
  }
  if (check.check === "typecheck") {
    return splitByTypecheckOutputParsing(check, testFilePatterns, typecheckOutputFormat);
  }
  return { testFindings: null, sourceFindings: null };
}
