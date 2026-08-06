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

import { getOperatorsForLanguage } from "./operators";
import type { Mutant, MutationOperator } from "./types";

export interface GenerateMutantsInput {
  /** Source code to mutate. */
  source: string;
  /** Detected project language. Unsupported languages yield an empty array. */
  language: string | undefined;
  /** Path of the file the mutants were generated for. */
  file: string;
}

function applyOperator(operator: MutationOperator, snippet: string): string[] {
  const result = operator.apply(snippet);
  return Array.isArray(result) ? result : [result];
}

export function generateMutants(input: GenerateMutantsInput): Mutant[] {
  const { source, language, file } = input;
  const operators = getOperatorsForLanguage(language);
  if (operators.length === 0) return [];

  const lines = source.split("\n");
  const mutants: Mutant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

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
