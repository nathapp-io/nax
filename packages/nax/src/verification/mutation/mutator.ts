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

/** Quote characters that open a string literal, per language family. */
const STRING_DELIMITERS = new Set(["'", '"', "`"]);

/**
 * Length of the leading run of `line` that is real code — everything before the
 * first string literal or inline comment.
 *
 * Operators are regex-driven and cannot tell `a == b` from `"a == b"` or from
 * `// a == b`. Mutating either produces a mutant that is worthless as a signal:
 * a flipped comparison inside a message string or a comment changes no
 * behaviour, so the tests "miss" it and it is reported as a survivor, while a
 * mutated string literal that IS asserted on is caught by construction. Both
 * consume one of the very few `maxMutants` slots the budget allows.
 *
 * Deliberately a PREFIX rather than a full segment map. Mutating each code
 * segment between literals would need the operator applied per segment and its
 * variants aligned across them — `MutationOperator.apply` returns bare strings
 * with no variant identity, so there is nothing to align on. Stopping at the
 * first literal loses the code that follows one on the same line, which costs
 * candidates but never produces a wrong mutant. For a spot-check that samples a
 * handful of sites, fewer-and-sound beats more-and-noisy.
 */
function codeRegionLength(line: string, language: string | undefined): number {
  const isPython = language === "python";
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (STRING_DELIMITERS.has(c)) return i;
    if (isPython) {
      if (c === "#") return i;
      continue;
    }
    if (c === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) return i;
  }
  return line.length;
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

    // Operators see only the code prefix; the literal/comment tail is carried
    // through verbatim so `before`/`after` still span the whole line, which is
    // what apply/revert compare against on disk.
    const codeLength = codeRegionLength(line, language);
    if (codeLength === 0) continue;
    const code = line.slice(0, codeLength);
    const tail = line.slice(codeLength);

    for (const operator of operators) {
      for (const mutatedCode of applyOperator(operator, code)) {
        if (mutatedCode === "" || mutatedCode === code) continue;
        mutants.push({
          file,
          line: lineNumber,
          before: line,
          after: `${mutatedCode}${tail}`,
          operatorId: operator.id,
        });
      }
    }
  }

  return mutants;
}
