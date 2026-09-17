/**
 * Context Engine v2 — scope-path matching primitives.
 *
 * A rule's `appliesTo:` frontmatter is matched in two places that must agree:
 *
 *   - rule SELECTION    (`static-rules.ts` `ruleMatchesScopeFiles`)
 *   - chunk ATTRIBUTION (`effectiveness.ts` `pathMatchesScope`)
 *
 * They used to carry separate copies of the literal-vs-glob branch and
 * disagreed: selection suffix-globbed a literal while attribution required an
 * exact match, so a rule could be admitted for a story and then penalised as
 * "ignored" for being followed (PR #2099 follow-up 8, finding H8). Both sites
 * now share `isGlobScopePath`, `normalizePath` and `globToRegex`, so they
 * cannot drift again.
 *
 * `frameAppliesTo` reconciles the other half of the mismatch: a per-package
 * rule's `appliesTo:` literal is package-relative, while `scopeFiles` and the
 * git diff are repo-rooted (nax#2071). Re-spelling a literal with its owning
 * package before comparison keeps #2091's exact anchoring — a repo-framed
 * literal still cannot match a same-named file in another package — while
 * letting a package-relative literal match its repo-framed file.
 *
 * This module is deliberately a leaf: it does not import from `static-rules.ts`
 * (which imports it), because effectiveness.ts must keep importing
 * `globToRegex`/`normalizePath` from `./providers/static-rules` — the
 * documented cycle-drain exemption in
 * test/unit/context/engine/effectiveness-barrel.test.ts.
 */

import type { CanonicalRule } from "@/context/rules/canonical-loader";
import { toRepoFrame } from "@/utils/path-frame";

/**
 * nax#2091: a scope path carrying any of these is an authored glob; without
 * them it is a literal and must anchor exactly. `globToRegex` is suffix-anchored
 * (`(?:^|/)...$`), so a package-relative literal "src/client.ts" matched a
 * same-named file in another package (packages/web/src/client.ts).
 *
 * The predicate below tests this against the NORMALIZED pattern — the same
 * string the literal comparison uses (finding L5: the previous code tested the
 * raw pattern while comparing the normalized one).
 */
export const SCOPE_GLOB_META = /[*?[{]/;

/** Posix separators, no leading "./". */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const beforeSlash = i > 0 && pattern[i - 1] === "/";
        const afterSlash = pattern[i + 2] === "/";
        if (beforeSlash && afterSlash) {
          regex = `${regex}(?:.*\\/)?`;
          i += 3;
        } else if (afterSlash) {
          regex += "(?:.*\\/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
        continue;
      }
      regex += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      regex += "[^/]";
      i++;
      continue;
    }
    if (`.+^\${}()|[]\\`.includes(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
    i++;
  }
  return new RegExp(`(?:^|/)${regex}$`);
}

/**
 * True when a scope pattern is an authored glob rather than a literal.
 * Normalizes first so the metacharacter test and the literal comparison are
 * made against the same string (finding L5).
 */
export function isGlobScopePath(pattern: string): boolean {
  return SCOPE_GLOB_META.test(normalizePath(pattern));
}

/**
 * Re-spell a rule's literal `appliesTo:` entries into the repo frame using the
 * owning package's repo-relative workdir. Authored globs are left untouched:
 * `globToRegex` is suffix-anchored, so a package-relative glob already matches
 * a repo-framed file, and prefixing an already-repo-rooted glob would be
 * ambiguous.
 */
export function frameAppliesTo(rule: CanonicalRule, packageWorkdir: string): CanonicalRule {
  if (!rule.appliesTo || rule.appliesTo.length === 0) return rule;
  return {
    ...rule,
    appliesTo: rule.appliesTo.map((pattern) =>
      isGlobScopePath(pattern) ? pattern : toRepoFrame(pattern, packageWorkdir),
    ),
  };
}
