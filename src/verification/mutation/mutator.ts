/**
 * Mutation generation core — pure, deterministic mutant generation.
 *
 * Walks the source line-by-line, applies every language-scoped operator
 * to each line, and emits a `Mutant` per (operator, line) pair whose
 * replacement is non-empty. No I/O — `file` is just metadata carried
 * onto each mutant for downstream reporting.
 */

import { getOperatorsForLanguage } from "./operators";
import type { Mutant, MutationOperator } from "./types";

export interface GenerateMutantsInput {
  /** Source code to mutate. */
  source: string;
  /** Detected project language. Unsupported languages yield an empty array. */
  language: string | undefined;
  /** Path of the file the mutants were generated for. */
  file: string;
  /** Cap on the number of mutants returned. Defaults to unbounded. */
  max?: number;
}

function applyOperator(operator: MutationOperator, snippet: string): string[] {
  const result = operator.apply(snippet);
  return Array.isArray(result) ? result : [result];
}

export function generateMutants(input: GenerateMutantsInput): Mutant[] {
  const { source, language, file, max } = input;
  const operators = getOperatorsForLanguage(language);
  if (operators.length === 0) return [];

  const lines = source.split("\n");
  const mutants: Mutant[] = [];

  outer: for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;

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
        if (max !== undefined && mutants.length >= max) break outer;
      }
    }
  }

  return mutants;
}
