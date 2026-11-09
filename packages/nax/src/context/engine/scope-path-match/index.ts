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

/**
 * Compiled-pattern memo (PERF-12). `globToRegex` is called from inside
 * `files.some(...)` within `appliesTo.some(...)` (`static-rules.ts`) and once
 * per chunk in `effectiveness.ts` `pathMatchesScope`, so a run recompiled the
 * same pattern once per pattern × scope-file pair.
 *
 * The key is the raw string the caller passes, and that space is NOT limited to
 * authored config: `pathMatchesScope` is fed `manifest.chunkScopePaths`, which
 * providers populate with RUNTIME file paths — e.g. `git-history.ts` pushes
 * `entry.file` and `code-neighbor-chunk.ts` pushes `rendered.path`. A runtime
 * path that happens to contain a glob metacharacter (`app/blog/[slug]/page.tsx`)
 * passes `isGlobScopePath` and is compiled. The cap below therefore keeps the
 * map from growing for the process lifetime; once it is full, a new pattern is
 * still compiled (behavior unchanged) but not retained.
 *
 * Sharing one instance across callers is safe: the compiled regex has no
 * global/sticky flag, so `.test()` carries no `lastIndex` state.
 */
export const MAX_GLOB_REGEX_CACHE_ENTRIES = 1024;

const GLOB_REGEX_CACHE = new Map<string, RegExp>();

/** Test seam: number of compiled patterns currently memoized. */
export function _globRegexCacheSize(): number {
  return GLOB_REGEX_CACHE.size;
}

/** Test seam: drop every memoized pattern. */
export function _resetGlobRegexCache(): void {
  GLOB_REGEX_CACHE.clear();
}

/**
 * Characters that carry regex meaning of their own and must be escaped when
 * a glob means them literally.
 */
const REGEX_META_CHARS = `.+^\${}()|[]\\`;

/**
 * True when the pattern's braces are balanced: every `{` has a matching `}`
 * and no `}` is left over.
 *
 * An unbalanced pattern keeps every brace literal. Bash and minimatch expand
 * neither a group that cannot be closed nor a stray `}`, and a half-open
 * group is far more likely to be a literal `{` in a filename (e.g. a
 * template directory) than a glob the author meant to expand.
 */
function bracesBalanced(pattern: string): boolean {
  let depth = 0;
  for (const c of pattern) {
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      if (depth === 0) return false;
      depth--;
    }
  }
  return depth === 0;
}

/**
 * Index of the `}` that closes the group opened at `start`, or -1 when the
 * group is never closed. Nested groups are counted, so the group opened by
 * `{a,b/{c,d}}` closes at its last `}`.
 */
function findBraceGroupEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * A group's content split on its top-level commas — the commas that are not
 * inside a nested group. `{a,b/{c,d}}` has one top-level comma (two
 * alternatives); `{a{b,c}}` has none.
 */
function splitTopLevelAlternatives(content: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of content) {
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
    }
    if (c === "," && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  alternatives.push(current);
  return alternatives;
}

/**
 * The regex a glob segment compiles to, plus whether it consumed the first
 * character of the text that follows it.
 */
interface SegmentTranslation {
  regex: string;
  /**
   * True when the segment's regex already consumes the first character of the
   * text that follows it. A brace group whose alternative ends in `**` is a
   * globstar that swallows the slash after the group, so that slash is emitted
   * once — inside the group — and not again after it.
   */
  absorbed: boolean;
}

/** One `*` / `**` run: the regex it compiles to and where the scan resumes. */
interface StarTranslation extends SegmentTranslation {
  /** Index of the first character after the run. */
  next: number;
}

/** A globstar directory prefix: zero or more path segments, each with its slash. */
const GLOBSTAR_DIR = "(?:.*\\/)?";

/**
 * Compile one `*` / `**` run.
 *
 * `**` is a globstar only when a slash follows it: a globstar followed by a
 * slash matches zero or more directories. A `**` that ends a segment whose
 * follower starts with a slash is that same globstar seen from the other side
 * — the slash it consumes sits after the segment, not inside it. That is the
 * case for an alternative of a brace group: `src/{**,lib}/x.ts` must match
 * `src/x.ts` exactly like the expanded `src/**` + `/x.ts` does.
 */
function translateStars(text: string, start: number, follower: string): StarTranslation {
  if (text[start + 1] !== "*") return { regex: "[^/]*", next: start + 1, absorbed: false };
  if (text[start + 2] === "/") return { regex: GLOBSTAR_DIR, next: start + 3, absorbed: false };
  if (start + 2 === text.length && follower.startsWith("/")) {
    return { regex: GLOBSTAR_DIR, next: start + 2, absorbed: true };
  }
  return { regex: ".*", next: start + 2, absorbed: false };
}

/**
 * Translate one brace group's content.
 *
 * A group with at least one top-level comma becomes a non-capturing
 * alternation (`{a,b}` → `(?:a|b)`), and an empty alternative is allowed
 * (`{a,}` → `(?:a|)`). A group with no comma stays literal (`{a}` → `\{a\}`)
 * — bash and minimatch expand neither `{a}` nor `{}`.
 *
 * The alternatives keep the glob meaning of their own content: `*`, `**` and
 * `?` stay wildcards, every other character stays regex-escaped. They also
 * keep the meaning the same text has outside the group: `follower` is what
 * follows the group, so an alternative ending in `**` is a globstar when that
 * follower starts with a slash.
 */
function translateBraceGroup(content: string, follower: string): SegmentTranslation {
  const alternatives = splitTopLevelAlternatives(content);
  if (alternatives.length < 2) {
    // A group with no top-level comma stays literal; a nested group inside it still expands.
    const inner = translateGlobText(content, true, `}${follower}`);
    return { regex: `\\{${inner.regex}\\}`, absorbed: inner.absorbed };
  }
  const parts = alternatives.map((alternative) => translateGlobText(alternative, true, follower));
  // An alternative that swallowed the slash after the group leaves the other
  // alternatives needing it: it is emitted inside the group instead.
  const anyAbsorbed = parts.some((part) => part.absorbed);
  const body = parts.map((part) => (anyAbsorbed && !part.absorbed ? `${part.regex}\\/` : part.regex)).join("|");
  return { regex: `(?:${body})`, absorbed: anyAbsorbed };
}

/**
 * Translate glob text into a regex body.
 *
 * `expandBraces` is false for a pattern whose braces are unbalanced: every
 * `{`, `}` and `,` then stays literal, exactly as before brace support.
 *
 * `follower` is the text that comes after `text` in the whole pattern. It
 * decides the meaning of a `**` that ends the segment: a globstar needs the
 * slash that follows it, and that slash can sit after a closing brace.
 */
function translateGlobText(text: string, expandBraces: boolean, follower = ""): SegmentTranslation {
  let regex = "";
  let i = 0;
  let absorbed = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "{" && expandBraces) {
      const end = findBraceGroupEnd(text, i);
      if (end !== -1) {
        const rest = text.slice(end + 1);
        const group = translateBraceGroup(text.slice(i + 1, end), rest + follower);
        regex += group.regex;
        if (group.absorbed && rest.length > 0) {
          // The group swallowed the slash that follows it, inside this text.
          i = end + 2;
        } else {
          // Either nothing was swallowed, or the swallowed slash is the first
          // character of this segment's follower.
          absorbed = absorbed || group.absorbed;
          i = end + 1;
        }
        continue;
      }
    }
    if (c === "*") {
      const star = translateStars(text, i, follower);
      regex += star.regex;
      absorbed = absorbed || star.absorbed;
      i = star.next;
      continue;
    }
    if (c === "?") {
      regex += "[^/]";
      i++;
      continue;
    }
    regex += REGEX_META_CHARS.includes(c) ? `\\${c}` : c;
    i++;
  }
  return { regex, absorbed };
}

/**
 * Compile a scope pattern into a regex.
 *
 * A balanced brace group expands into an alternation, so
 * `src/` + `**` + `/*.{ts,tsx}` matches `src/a.ts` and `src/deep/b.tsx`
 * instead of only the literal text `*.{ts,tsx}` (review finding M16).
 * Everything else is unchanged: `*`, `**` and `?` keep their meaning, a comma
 * outside any group stays literal, and an unbalanced pattern keeps every
 * brace literal.
 */
export function globToRegex(pattern: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(pattern);
  if (cached !== undefined) return cached;

  const compiled = new RegExp(`(?:^|/)${translateGlobText(pattern, bracesBalanced(pattern)).regex}$`);
  if (GLOB_REGEX_CACHE.size < MAX_GLOB_REGEX_CACHE_ENTRIES) {
    GLOB_REGEX_CACHE.set(pattern, compiled);
  }
  return compiled;
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

/**
 * Returns true when the rule's `appliesTo:` frontmatter (file-scope filter)
 * matches at least one entry in the effective scope-file set. Fail-open: a rule
 * with no `appliesTo:` always matches, and an empty/absent scope set admits
 * every rule unconditionally (see ProviderScopingReport.appliesToInertCount for
 * visibility).
 *
 * Keyed on `request.scopeFiles` (rule-scoping), not `request.touchedFiles` —
 * scopeFiles is the resolved evidence set, touchedFiles is content-fetch input.
 *
 * Lives here (moved from `static-rules.ts` for US-001) so the rule-set resolver
 * can share the matcher without importing the provider that imports it: a
 * provider -> rule-set -> provider edge would close a runtime cycle, and the
 * selection/attribution agreement this function exists to guarantee (PR #2099
 * follow-up 8) is exactly what a second copy would put back at risk.
 */
export function ruleMatchesScopeFiles(appliesTo: string[] | undefined, scopeFiles: string[] | undefined): boolean {
  if (!appliesTo || appliesTo.length === 0) return true;
  if (!scopeFiles || scopeFiles.length === 0) return true;

  const files = scopeFiles.map((f) => normalizePath(f));
  return appliesTo.some((pattern) => {
    const normalizedPattern = normalizePath(pattern);
    // Literal (no glob metacharacter): anchor exactly — the same rule
    // effectiveness.ts's pathMatchesScope applies, so a rule cannot be admitted
    // for selection and then denied attribution (#2091 / follow-up 8).
    return files.some((file) =>
      isGlobScopePath(normalizedPattern) ? globToRegex(normalizedPattern).test(file) : normalizedPattern === file,
    );
  });
}

/**
 * Returns true when a rule's `paths:` frontmatter (package-scope filter) matches
 * the current package directory relative to the repo root.
 * Rules with no `paths:` field are global and always match.
 * Single-package repos (packageDir === repoRoot) always match regardless of paths.
 *
 * The package-relative frame comes from `storyWorkdir` (request.storyWorkdir,
 * PRD-declared), NOT `relative(repoRoot, packageDir)`: for a `packageDir` rooted
 * inside a nax worktree, `repoRoot` is the main checkout while `packageDir` is
 * `<root>/.nax-wt/<storyId>/<pkg>`, so that derivation yields
 * `.nax-wt/<storyId>/<pkg>` instead of `<pkg>` (nax#2111, same defect class as
 * H8 / nax#2069). `storyWorkdir` is immune to which checkout `packageDir`
 * happens to be rooted at.
 *
 * A missing/"." storyWorkdir falls back to "." (no package frame). This can
 * only be reached when `packageDir !== repoRoot` yet the caller omitted
 * `storyWorkdir` — `static-rules.ts`'s fast path (`packageDir === repoRoot`)
 * already covers the single-package and pull-tool-handler cases where
 * `storyWorkdir` is legitimately absent (see `ContextRequest.storyWorkdir`'s
 * docblock in `../types.ts` and the mirrored fallback at its AC-57
 * package-rule overlay).
 *
 * Moved here from `static-rules.ts` for the file-size gate (nax#2113's repo-rule
 * hoist pushed that file to 624/600 lines) — this module is the designated leaf
 * for scope/frame matching primitives.
 */
export function ruleMatchesPackage(
  paths: string[] | undefined,
  repoRoot: string,
  packageDir: string,
  storyWorkdir: string | undefined,
): boolean {
  if (!paths || paths.length === 0) return true;
  if (packageDir === repoRoot) return true;

  const rel = normalizePath(storyWorkdir ?? ".");
  const patterns = paths.map((p) => globToRegex(normalizePath(p)));
  // Also test rel + "/" so that "packages/api/**" matches the base dir "packages/api"
  return patterns.some((pattern) => pattern.test(rel) || pattern.test(`${rel}/`));
}
