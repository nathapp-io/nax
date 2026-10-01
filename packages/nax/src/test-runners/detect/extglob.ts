/**
 * Extglob + brace expansion for glob patterns emitted by Tier 1 framework
 * config parsers (Jest, Vitest, Mocha).
 *
 * Downstream consumers (`globsToTestRegex`, `extractTestDirs`, etc.) only
 * understand the suffix after the last `*`. Extglob constructs like
 * `?(x)`, `+(spec|test)`, `[jt]s?(x)` and brace alternatives like
 * `{test,spec}.{ts,js}` corrupt that suffix and produce regexes that match
 * literal extglob characters (matching nothing in real file paths).
 *
 * This module expands such constructs into a flat list of simple globs.
 *
 * Handled forms:
 * - Brace alternation: `{a,b}`        → `a`, `b`
 * - Character class:   `[abc]`        → `a`, `b`, `c`
 * - Optional group:    `?(x|y)`       → ``, `x`, `y`
 * - Zero-or-more:      `*(x|y)`       → ``, `x`, `y`
 * - One-or-more:       `+(x|y)`       → `x`, `y`
 * - Exactly-one:       `@(x|y)`       → `x`, `y`
 *
 * Unsupported (returned as-is so callers can decide what to do):
 * - Negation `!(x)`
 * - Character ranges `[a-z]`
 * - Nested brace/extglob constructs deeper than the iteration cap
 *
 * The `+()` and `*()` semantics technically allow repetition; here we treat
 * them as alternation, which is sufficient for suffix-based regex matching.
 */

const MAX_VARIANTS = 64;
const MAX_PASSES = 10;

/** Returns true when the pattern contains a character range (e.g. `[a-z]`). */
function hasCharRange(pattern: string): boolean {
  return /\[[^\]]*-[^\]]*\]/.test(pattern);
}

/** Returns true when the pattern uses an extglob construct we cannot expand. */
function hasUnsupported(pattern: string): boolean {
  return pattern.includes("!(") || hasCharRange(pattern);
}

interface Construct {
  re: RegExp;
  withEmpty: boolean;
  charClass: boolean;
  /** Separator used to split `body` into alternatives. Braces use ",", extglob uses "|". */
  separator: string;
}

const CONSTRUCTS: readonly Construct[] = [
  { re: /\{([^{}]+)\}/, withEmpty: false, charClass: false, separator: "," },
  { re: /\?\(([^()]*)\)/, withEmpty: true, charClass: false, separator: "|" },
  { re: /\*\(([^()]*)\)/, withEmpty: true, charClass: false, separator: "|" },
  { re: /\+\(([^()]*)\)/, withEmpty: false, charClass: false, separator: "|" },
  { re: /@\(([^()]*)\)/, withEmpty: false, charClass: false, separator: "|" },
  { re: /\[([^\]]+)\]/, withEmpty: false, charClass: true, separator: "" },
];

/** Expand the leftmost construct in `pattern`. Returns `[pattern]` if none found. */
function expandLeftmost(pattern: string): string[] {
  let earliest: { match: RegExpMatchArray; spec: Construct } | null = null;
  for (const spec of CONSTRUCTS) {
    const m = pattern.match(spec.re);
    if (m?.index !== undefined) {
      if (earliest === null || m.index < (earliest.match.index ?? Number.POSITIVE_INFINITY)) {
        earliest = { match: m, spec };
      }
    }
  }

  if (!earliest) return [pattern];

  const full = earliest.match[0];
  const body = earliest.match[1];
  const start = earliest.match.index as number;
  const before = pattern.slice(0, start);
  const after = pattern.slice(start + full.length);

  let alternatives = earliest.spec.charClass ? [...body] : body.split(earliest.spec.separator);
  if (earliest.spec.withEmpty) alternatives = ["", ...alternatives];

  return alternatives.map((alt) => `${before}${alt}${after}`);
}

/**
 * Expand all extglob and brace constructs in a pattern into a list of simple globs.
 *
 * Returns the original pattern in a single-element array when:
 * - The pattern contains no extglob/brace syntax.
 * - The pattern uses unsupported constructs (negation, character ranges).
 * - Expansion would exceed `MAX_VARIANTS` (returns the partial expansion at that point).
 *
 * @example
 * expandExtglob("**\/?(*.)+(spec|test).[jt]s?(x)")
 * // → ["**\/spec.js", "**\/spec.jsx", ..., "**\/*.test.tsx"] (16 variants)
 */
export function expandExtglob(pattern: string): string[] {
  if (hasUnsupported(pattern)) return [pattern];

  let variants = [pattern];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next: string[] = [];
    let changed = false;
    for (const v of variants) {
      const expanded = expandLeftmost(v);
      if (expanded.length > 1 || expanded[0] !== v) changed = true;
      next.push(...expanded);
      if (next.length > MAX_VARIANTS) break;
    }
    variants = [...new Set(next)];
    if (!changed) break;
    if (variants.length > MAX_VARIANTS) break;
  }
  return variants;
}

/**
 * Expand a list of patterns and de-duplicate the result.
 * Convenience wrapper for parsers that emit multiple patterns.
 */
export function expandExtglobAll(patterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of patterns) {
    for (const expanded of expandExtglob(p)) {
      if (!seen.has(expanded)) {
        seen.add(expanded);
        result.push(expanded);
      }
    }
  }
  return result;
}
