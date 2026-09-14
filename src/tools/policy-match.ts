/**
 * Pattern compilation for the tool policy: globs, argv tokens, and the
 * deny/ask rule maps.
 *
 * Extracted from `policy.ts` to keep that file under the 600-line source
 * limit. `src/` reaches this module only through `policy.ts`, so the barrel
 * surface is unchanged; tests may import it directly.
 */

import type { ToolGrant } from "./types";

/**
 * Minimatch-style glob to RegExp: `**` spans separators, `*` does not.
 *
 * `**` followed by `/` is zero or more COMPLETE directory segments, which is
 * why it does not simply compile to `.*`. `.*` both spans separators and
 * matches the empty string, so emitting it and dropping the separator erased
 * the boundary: `src/**\/config.ts` became `^src\/.*config\.ts$`, and a grant
 * for files named `config.ts` also admitted `src/legacyconfig.ts`.
 *
 * That was never a root escape -- containment runs before any pattern matching
 * -- but it made a *scoped* grant wider than its author wrote, which is the one
 * thing a scoped profile exists to prevent.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          // Optional, so `x/**/y` still matches `x/y` -- minimatch's behaviour.
          out += "(?:.*/)?";
          i += 1;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** A compiled glob, keeping its source so verb names can be told from paths. */
export interface CompiledPattern {
  readonly source: string;
  readonly re: RegExp;
}

/**
 * A deny/ask rule list compiled for one tool.
 *
 * Unlike the allow compiler (last-write-wins per tool, by design),
 * rules for the same tool MERGE here: patterns are concatenated and any
 * `"*"` makes the whole entry unconditional. That is safe -- and correct --
 * because deny/ask are additive; a later rule must never silently drop an
 * earlier one.
 */
export interface CompiledEntry {
  readonly unconditional: boolean;
  readonly matchers: CompiledPattern[];
  readonly argvPatterns: readonly (readonly CompiledPattern[])[];
  readonly raw: readonly string[];
  /** Patterns grouped by their original rule expression for ask telemetry. */
  readonly rulePatterns?: readonly (readonly string[])[];
}

export function matchesAny(patterns: readonly CompiledPattern[], value: string): boolean {
  return patterns.some((p) => p.re.test(value));
}

/** The source of the first compiled glob matching `value`, for naming a rule. */
export function matchedGlobSource(patterns: readonly CompiledPattern[], value: string): string | undefined {
  return patterns.find((p) => p.re.test(value))?.source;
}

/**
 * Split a grant pattern into whitespace-separated tokens, each compiled
 * independently. Per-token compilation (rather than joining argv with
 * spaces and matching one regex against the joined string) is deliberate:
 * a joined string lets a value containing spaces or glob metacharacters
 * shift what a later token appears to match. `"bun add*"` must mean "argv[0]
 * is exactly bun, argv[1] starts with add", never "the space-joined argv
 * matches this glob".
 */
export function compileArgvPattern(pattern: string): readonly CompiledPattern[] {
  return pattern
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => ({ source: token, re: globToRegExp(token) }));
}

/** A grant pattern's tokens are a PREFIX of argv — trailing argv tokens
 * (the package name, flags, ...) are the payload a prefix grant like
 * `bun add*` does not itself constrain. */
export function matchesArgvPattern(tokens: readonly CompiledPattern[], argv: readonly string[]): boolean {
  if (tokens.length > argv.length) return false;
  return tokens.every((token, i) => token.re.test(argv[i] as string));
}

export function matchesArgvGrant(
  argvPatterns: readonly (readonly CompiledPattern[])[],
  argv: readonly string[],
): boolean {
  return argvPatterns.some((tokens) => matchesArgvPattern(tokens, argv));
}

/**
 * Compile a deny/ask list. Deliberately separate from the allow compiler: the
 * allow map overwrites, and unifying the two would change verdicts for any
 * config carrying two expressions for one tool (the byte-identity regression
 * gate pins that). Merging is safe for deny/ask because those lists are new
 * and additive.
 */
export function compileRuleMap(rules: readonly ToolGrant[] | undefined): Map<string, CompiledEntry> {
  const map = new Map<string, CompiledEntry>();
  for (const rule of rules ?? []) {
    const existing = map.get(rule.tool);
    const patterns = existing === undefined ? rule.patterns : [...existing.raw, ...rule.patterns];
    const nonWildcard = patterns.filter((p) => p !== "*");
    map.set(rule.tool, {
      unconditional: patterns.includes("*"),
      matchers: nonWildcard.map((source) => ({ source, re: globToRegExp(source) })),
      argvPatterns: nonWildcard.map((source) => compileArgvPattern(source)),
      raw: patterns,
      rulePatterns: [...(existing?.rulePatterns ?? []), rule.patterns],
    });
  }
  return map;
}

/** The configured expression-group containing a matched pattern, if any. */
export function matchedRulePatterns(entry: CompiledEntry, source: string): readonly string[] {
  return entry.rulePatterns?.find((patterns) => patterns.includes(source)) ?? entry.raw;
}

/** The original pattern whose tokens matched `argv`, for naming an ask rule. */
export function matchedArgvSource(entry: CompiledEntry, argv: readonly string[]): string | undefined {
  const index = entry.argvPatterns.findIndex((tokens) => matchesArgvPattern(tokens, argv));
  if (index === -1) return undefined;
  return entry.raw.filter((p) => p !== "*")[index];
}
