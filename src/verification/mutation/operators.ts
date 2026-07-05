/**
 * Mutation generation core — per-language operator tables.
 *
 * Operators are deterministic: a given input snippet maps to a fixed set of
 * replacements. Each operator carries a stable id used by the result
 * classifier to identify which transformation produced a given mutant.
 */

import type { MutationOperator } from "./types";

type PatternReplacement = readonly [RegExp, string];

/**
 * Comparison-operator flips. Patterns are module-local so they are
 * reused across calls without leaking `lastIndex` state.
 */
const TS_COMPARISON_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/==/g, "!="],
  [/!=/g, "=="],
  [/===/g, "!=="],
  [/!==/g, "==="],
  [/>/g, "<"],
  [/</g, ">"],
  [/>=/g, "<="],
  [/<=/g, ">="],
];

const TS_COMPARISON_FLIP_ID = "ts:cmp-flip";

function flipWithPairs(pairs: ReadonlyArray<PatternReplacement>, snippet: string): string[] {
  const results: string[] = [];
  for (const [pattern, replacement] of pairs) {
    if (pattern.test(snippet)) {
      pattern.lastIndex = 0;
      results.push(snippet.replace(pattern, replacement));
    }
  }
  return results;
}

const TS_BOOLEAN_FLIP_ID = "ts:bool-flip";

function applyBooleanFlip(snippet: string): string[] {
  const results: string[] = [];
  if (/\btrue\b/.test(snippet)) results.push(snippet.replace(/\btrue\b/g, "false"));
  if (/\bfalse\b/.test(snippet)) results.push(snippet.replace(/\bfalse\b/g, "true"));
  return results;
}

const TS_ARITHMETIC_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/\+/g, "-"],
  [/-/g, "+"],
  [/\*/g, "/"],
  [/\//g, "*"],
];

const TS_ARITHMETIC_FLIP_ID = "ts:arith-flip";

const TYPESCRIPT_OPERATORS: ReadonlyArray<MutationOperator> = [
  { id: TS_COMPARISON_FLIP_ID, apply: (snippet) => flipWithPairs(TS_COMPARISON_PAIRS, snippet) },
  { id: TS_BOOLEAN_FLIP_ID, apply: applyBooleanFlip },
  { id: TS_ARITHMETIC_FLIP_ID, apply: (snippet) => flipWithPairs(TS_ARITHMETIC_PAIRS, snippet) },
];

const PYTHON_OPERATORS: ReadonlyArray<MutationOperator> = [];
const GO_OPERATORS: ReadonlyArray<MutationOperator> = [];

const SUPPORTED_LANGUAGES: ReadonlyMap<string, ReadonlyArray<MutationOperator>> = new Map([
  ["typescript", TYPESCRIPT_OPERATORS],
  ["javascript", TYPESCRIPT_OPERATORS],
  ["python", PYTHON_OPERATORS],
  ["go", GO_OPERATORS],
]);

export function getOperatorsForLanguage(language: string | undefined): ReadonlyArray<MutationOperator> {
  if (!language) return [];
  return SUPPORTED_LANGUAGES.get(language) ?? [];
}
