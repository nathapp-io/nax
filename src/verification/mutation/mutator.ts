/**
 * Mutation generation core — pure, deterministic mutant generation.
 *
 * Walks the source line-by-line, applies every language-scoped operator
 * to each line, and emits a `Mutant` per (operator, line) pair whose
 * replacement is non-empty. No I/O — `file` is just metadata carried
 * onto each mutant for downstream reporting. Selection (budget caps,
 * even-spread sampling) lives in `./select.ts` and is applied by the
 * caller over the combined candidate list.
 */

import type { LineRange } from "@/utils/diff-files";
import { getOperatorsForLanguage } from "./operators";
import type { Mutant, MutationOperator } from "./types";

export interface GenerateMutantsInput {
  /** Source code to mutate. */
  source: string;
  /** Detected project language. Unsupported languages yield an empty array. */
  language: string | undefined;
  /** Path of the file the mutants were generated for. */
  file: string;
  /**
   * Optional line ranges eligible for mutation (e.g. changed-side ranges from a
   * git diff). When provided, lines outside every range are skipped. Omitting
   * the field preserves the whole-file behaviour.
   */
  lineRanges?: readonly LineRange[];
}

function applyOperator(operator: MutationOperator, snippet: string): string[] {
  const result = operator.apply(snippet);
  return Array.isArray(result) ? result : [result];
}

function isLineInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
  for (const range of ranges) {
    if (lineNumber >= range.start && lineNumber <= range.end) return true;
  }
  return false;
}

export function generateMutants(input: GenerateMutantsInput): Mutant[] {
  const { source, language, file, lineRanges } = input;
  const operators = getOperatorsForLanguage(language);
  if (operators.length === 0) return [];
  if (lineRanges !== undefined && lineRanges.length === 0) return [];

  const lines = source.split("\n");
  const mutants: Mutant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    if (lineRanges !== undefined && !isLineInRanges(lineNumber, lineRanges)) continue;

    const trimmed = line.trim();
    const commentPrefixes = language === "python" ? ["#"] : ["//", "/*", "*"];
    if (commentPrefixes.some((prefix) => trimmed.startsWith(prefix))) continue;

    for (const operator of operators) {
      for (const replacement of applyOperator(operator, line)) {
        if (replacement === "" || replacement === line) continue;
        mutants.push({
          file,
          line: lineNumber,
          before: line,
          after: replacement,
          operatorId: operator.id,
        });
      }
    }
  }

  return mutants;
}
