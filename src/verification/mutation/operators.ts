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
 * TypeScript/JavaScript comparison flips — includes the JS-only strict-equality
 * operators (`===` / `!==`).
 */
const TS_COMPARISON_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/==/g, "!="],
  [/!=/g, "=="],
  [/===/g, "!=="],
  [/!==/g, "==="],
  [/>=/g, "<="],
  [/<=/g, ">="],
];

/**
 * Comparison flips shared by all languages — the TS subset minus the JS-only
 * strict-equality operators (`===` / `!==`), which Python/Go/Rust do not have.
 */
const UNIVERSAL_COMPARISON_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/==/g, "!="],
  [/!=/g, "=="],
  [/>=/g, "<="],
  [/<=/g, ">="],
];

// Bare >/< flips require whitespace on both sides — the shape a real
// comparison takes (`a > b`), but neither an arrow function (`x => x`, no
// space before `>`) nor a generic (`Array<string>`, no space before `<` and
// none before the closing `>` either) takes. Scoping this way avoids
// producing mutants that fail to compile — always "killed" regardless of
// test quality.
const COMPARISON_GT = /(?<=\s)>(?!=)(?=\s|$)/g;
const COMPARISON_LT = /(?<=\s)<(?!=)(?=\s)/g;

function applyComparisonBracketFlip(snippet: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  if (COMPARISON_GT.test(snippet)) {
    COMPARISON_GT.lastIndex = 0;
    const produced = snippet.replace(COMPARISON_GT, "<");
    if (produced !== snippet) {
      seen.add(produced);
      results.push(produced);
    }
  }
  if (COMPARISON_LT.test(snippet)) {
    COMPARISON_LT.lastIndex = 0;
    const produced = snippet.replace(COMPARISON_LT, ">");
    if (produced !== snippet && !seen.has(produced)) {
      results.push(produced);
    }
  }
  return results;
}

function flipWithPairs(pairs: ReadonlyArray<PatternReplacement>, snippet: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const [pattern, replacement] of pairs) {
    if (pattern.test(snippet)) {
      pattern.lastIndex = 0;
      const produced = snippet.replace(pattern, replacement);
      if (!seen.has(produced)) {
        seen.add(produced);
        results.push(produced);
      }
    }
  }
  return results;
}

/**
 * Build a boolean-literal flip for a language's spelling of true/false
 * (`true`/`false` for TS/Go/Rust, `True`/`False` for Python). Fresh regexes
 * per call keep the shared `lastIndex` hazard out.
 */
function makeBooleanFlip(trueLit: string, falseLit: string): (snippet: string) => string[] {
  return (snippet: string) => {
    const seen = new Set<string>();
    const results: string[] = [];
    if (new RegExp(`\\b${trueLit}\\b`).test(snippet)) {
      const produced = snippet.replace(new RegExp(`\\b${trueLit}\\b`, "g"), falseLit);
      seen.add(produced);
      results.push(produced);
    }
    if (new RegExp(`\\b${falseLit}\\b`).test(snippet)) {
      const produced = snippet.replace(new RegExp(`\\b${falseLit}\\b`, "g"), trueLit);
      if (!seen.has(produced)) results.push(produced);
    }
    return results;
  };
}

const ARITHMETIC_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/\+/g, "-"],
  [/-/g, "+"],
  [/\*/g, "/"],
  [/\//g, "*"],
];

const TYPESCRIPT_OPERATORS: ReadonlyArray<MutationOperator> = [
  { id: "ts:cmp-flip", apply: (snippet) => flipWithPairs(TS_COMPARISON_PAIRS, snippet) },
  { id: "ts:cmp-bracket-flip", apply: applyComparisonBracketFlip },
  { id: "ts:bool-flip", apply: makeBooleanFlip("true", "false") },
  { id: "ts:arith-flip", apply: (snippet) => flipWithPairs(ARITHMETIC_PAIRS, snippet) },
];

/**
 * Build the standard four-operator table for a language, scoped by an id
 * prefix and its boolean-literal spelling. Comparison / bracket / arithmetic
 * flips are language-neutral; only the boolean spelling differs.
 */
function makeOperators(prefix: string, trueLit: string, falseLit: string): ReadonlyArray<MutationOperator> {
  return [
    { id: `${prefix}:cmp-flip`, apply: (snippet) => flipWithPairs(UNIVERSAL_COMPARISON_PAIRS, snippet) },
    { id: `${prefix}:cmp-bracket-flip`, apply: applyComparisonBracketFlip },
    { id: `${prefix}:bool-flip`, apply: makeBooleanFlip(trueLit, falseLit) },
    { id: `${prefix}:arith-flip`, apply: (snippet) => flipWithPairs(ARITHMETIC_PAIRS, snippet) },
  ];
}

const PYTHON_OPERATORS = makeOperators("py", "True", "False");
const GO_OPERATORS = makeOperators("go", "true", "false");
const RUST_OPERATORS = makeOperators("rust", "true", "false");

const SUPPORTED_LANGUAGES: ReadonlyMap<string, ReadonlyArray<MutationOperator>> = new Map([
  ["typescript", TYPESCRIPT_OPERATORS],
  ["javascript", TYPESCRIPT_OPERATORS],
  ["python", PYTHON_OPERATORS],
  ["go", GO_OPERATORS],
  ["rust", RUST_OPERATORS],
]);

export function getOperatorsForLanguage(language: string | undefined): ReadonlyArray<MutationOperator> {
  if (!language) return [];
  return SUPPORTED_LANGUAGES.get(language) ?? [];
}
