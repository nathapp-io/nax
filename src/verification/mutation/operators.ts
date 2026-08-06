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
 *
 * Ordered longest-first: `flipWithPairs` resolves overlapping sites by
 * alternation order, so `===` / `!==` must precede `==` / `!=` or the strict
 * operators are consumed as the loose one they contain (issue #1487).
 */
const TS_COMPARISON_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/===/g, "!=="],
  [/!==/g, "==="],
  [/==/g, "!="],
  [/!=/g, "=="],
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

/** One matched operator site: where it starts and how many chars it spans. */
type Site = readonly [start: number, length: number];

/**
 * Produce one mutant per operator in `pairs` that occurs in `snippet`, with
 * every occurrence of that operator flipped together.
 *
 * The snippet is tokenized ONCE with a combined alternation regex, so each
 * character position is claimed by exactly one pair. Regex alternation is
 * leftmost-first, which is why the pair tables are ordered longest-first: it
 * makes an overlapping shorter operator structurally unable to match inside a
 * longer one, rather than relying on a per-pattern guard. Before this, the
 * `==` pair matched the `==` inside `!==` and rewrote it to the uncompilable
 * `!!=` (issue #1487).
 *
 * Pair patterns must not contain capturing groups — one group per pair is
 * added here to attribute each match back to the pair that produced it.
 */
function flipWithPairs(pairs: ReadonlyArray<PatternReplacement>, snippet: string): string[] {
  const combined = new RegExp(pairs.map(([pattern]) => `(${pattern.source})`).join("|"), "g");
  const sitesByPair = new Map<number, Site[]>();
  for (const match of snippet.matchAll(combined)) {
    const pairIndex = match.slice(1).findIndex((group) => group !== undefined);
    if (pairIndex < 0 || match[0].length === 0) continue;
    const sites = sitesByPair.get(pairIndex) ?? [];
    sites.push([match.index, match[0].length]);
    sitesByPair.set(pairIndex, sites);
  }

  const seen = new Set<string>();
  const results: string[] = [];
  for (const pairIndex of [...sitesByPair.keys()].sort((a, b) => a - b)) {
    const replacement = pairs[pairIndex]?.[1];
    if (replacement === undefined) continue;
    // Splice from the end so earlier sites keep their original offsets.
    let produced = snippet;
    for (const [start, length] of [...(sitesByPair.get(pairIndex) ?? [])].reverse()) {
      produced = produced.slice(0, start) + replacement + produced.slice(start + length);
    }
    if (produced !== snippet && !seen.has(produced)) {
      seen.add(produced);
      results.push(produced);
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

// Arithmetic flips require whitespace on both sides — the shape a real
// binary expression takes (`a + b`), but neither a module specifier
// (`"../config"`), a URL (`https://a/b/c`), nor a path fragment (`a/b/c`)
// takes. Whitespace-gating prevents producing mutants that fail to parse
// — always "killed" regardless of test quality. Trailing side requires
// whitespace (not end-of-string) so a dangling operator like `a +` is
// not mutated.
const ARITHMETIC_PAIRS: ReadonlyArray<PatternReplacement> = [
  [/(?<=\s)\+(?=\s\S)/g, "-"],
  [/(?<=\s)-(?=\s\S)/g, "+"],
  [/(?<=\s)\*(?=\s\S)/g, "/"],
  [/(?<=\s)\/(?=\s\S)/g, "*"],
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
