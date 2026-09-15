/**
 * Context Engine v2 — shared test-path derivation helpers.
 *
 * ADR-009 SSOT: the ONLY place that derives a prospective or sibling test
 * path from a source path and a set of resolved test-file globs. Extracted
 * from `code-neighbor.ts` (nax#2060) so `static-rules.ts` can also consult
 * it — the `monorepo-awareness` rule requires exactly one resolver per
 * concept, and this was already implemented once. Never re-derive test
 * paths inline; import from here.
 */

/**
 * Decompose a test-file glob into `{ prefix, suffix }` where:
 *   - `prefix` is the literal path segment(s) before the first `**` or `*`
 *   - `suffix` is whatever follows the last `*` wildcard
 *
 * Language-agnostic, works for:
 *   "test/unit/*\/*.test.ts" → { prefix: "test/unit/", suffix: ".test.ts" }
 *   "*\/*.test.ts"           → { prefix: "",           suffix: ".test.ts" }
 *   "*\/*_test.go"           → { prefix: "",           suffix: "_test.go" }
 *   "src/*\/*.spec.ts"       → { prefix: "src/",       suffix: ".spec.ts" }
 *
 * Returns null when no usable suffix can be extracted (pattern has no `*`
 * or the `*` is at the end with nothing after it).
 */
function decomposeTestGlob(pattern: string): { prefix: string; suffix: string } | null {
  const lastStar = pattern.lastIndexOf("*");
  if (lastStar === -1) return null;
  const suffix = pattern.slice(lastStar + 1);
  if (suffix.length === 0) return null;

  // First wildcard position — defines the literal prefix.
  const firstStar = pattern.indexOf("*");
  // Trim the trailing `/` of the prefix if present, so composition is clean.
  let prefix = pattern.slice(0, firstStar);
  if (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
  return { prefix, suffix };
}

/** Strip the trailing file extension from a path/suffix fragment. */
function stripExt(s: string): string {
  const m = s.match(/\.[^.]+$/);
  return m ? s.slice(0, -m[0].length) : s;
}

/**
 * Derive candidate sibling-test paths for a source file, in order of preference.
 *
 * ADR-009 compliant: no hardcoded extensions or directory names. Each glob in
 * `patterns` contributes up to two candidate shapes:
 *   1. Colocated — `<sourceStem><suffix>` (same directory as the source file)
 *   2. Mirrored  — `<globPrefix>/<innerStem><suffix>` (only when the source
 *      lives under `src/`, so we can substitute `src/` → `globPrefix/`)
 *
 * The caller:
 *   - Guards against test-file inputs via `resolved.regex` (prevents the
 *     `.test.test.ts` hallucination — #526 Bug 1).
 *   - Prefers candidates that exist on disk (#526 Bug 2).
 *
 * Returns an empty list when no candidate can be built — caller should then
 * skip the sibling-test hint entirely rather than fall back to hardcoding.
 */
export function deriveSiblingTestCandidates(filePath: string, patterns: readonly string[]): string[] {
  // Source extension (preserved when building candidates so `.tsx` stays `.tsx`
  // even when the configured glob only lists `.ts`).
  const srcExtMatch = filePath.match(/\.[^.]+$/);
  if (!srcExtMatch) return [];
  const srcExt = srcExtMatch[0];
  const stemWithPath = filePath.slice(0, -srcExt.length);

  // Bug 1 guard (#526): if the source already ends with any pattern's suffix,
  // it is itself a test file — skip derivation to prevent `.test.test.ts` /
  // `.spec.spec.ts` / `_test_test.go` hallucination. This is a universal check
  // independent of full-path regex classification, because a user's configured
  // `testFilePatterns` may scope to a directory (e.g. `test/unit/`) that does
  // not match a touched-file path like `src/foo.test.ts`.
  for (const pattern of patterns) {
    const decomposed = decomposeTestGlob(pattern);
    if (decomposed && filePath.endsWith(decomposed.suffix)) return [];
    // Also handle the case where the source's stem ends with a marker that,
    // combined with the source extension, would produce a duplicate-marker
    // candidate. e.g. source=src/foo.spec.jsx under pattern `**/*.test.ts`
    // shouldn't yield `src/foo.spec.test.jsx`.
    if (decomposed) {
      const markerFromSuffix = stripExt(decomposed.suffix);
      if (markerFromSuffix.length > 0 && stemWithPath.endsWith(markerFromSuffix)) return [];
    }
  }
  // Extra safety: guard against stems ending with common test markers even when
  // the specific pattern doesn't use the same separator — tests frequently come
  // into providers via PRD contextFiles as `src/foo.test.ts` or `src/foo.spec.ts`.
  if (stemWithPath.endsWith(".test") || stemWithPath.endsWith(".spec")) return [];

  // Mirrored-layout rewrite: substitute `src/` segment with the glob's literal
  // prefix (e.g. `test/unit/`). Skipped when the source path has no `src/`
  // anchor — we cannot infer the mapping without one.
  const srcPrefixed = stemWithPath.startsWith("src/");
  const srcInMiddleIdx = stemWithPath.indexOf("/src/");
  let innerStem: string | null = null;
  let pkgPrefix = "";
  if (srcPrefixed) {
    innerStem = stemWithPath.slice("src/".length);
  } else if (srcInMiddleIdx >= 0) {
    pkgPrefix = `${stemWithPath.slice(0, srcInMiddleIdx)}/`;
    innerStem = stemWithPath.slice(srcInMiddleIdx + "/src/".length);
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (path: string) => {
    if (path === filePath) return; // never return the source itself
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push(path);
    }
  };

  for (const pattern of patterns) {
    const decomposed = decomposeTestGlob(pattern);
    if (!decomposed) continue;
    const { prefix, suffix } = decomposed;

    // Split suffix into marker + its own extension. When the source extension
    // differs from the suffix's extension, preserve the source extension.
    // e.g. suffix=".test.ts", source=".tsx" → effective=".test.tsx"
    //      suffix="_test.go", source=".go"  → effective="_test.go"
    const suffixExt = (suffix.match(/\.[^.]+$/) ?? [""])[0];
    const marker = suffixExt ? suffix.slice(0, -suffixExt.length) : suffix;
    if (marker.length === 0) continue; // no marker → candidate would equal source
    const effectiveSuffix = `${marker}${srcExt}`;

    // Colocated — beside the source file.
    push(`${stemWithPath}${effectiveSuffix}`);
    // Mirrored — when we have a `src/` anchor and the glob has a literal prefix.
    if (innerStem !== null && prefix.length > 0) {
      push(`${pkgPrefix}${prefix}/${innerStem}${effectiveSuffix}`);
    }
  }
  return candidates;
}

/**
 * Decide whether `filePath` is itself a test file under the resolved patterns.
 * Used to skip sibling-test derivation for test-file inputs (prevents
 * `.test.test.ts` / `.spec.spec.ts` hallucination — #526 Bug 1).
 */
export function isTestFile(filePath: string, regex: readonly RegExp[]): boolean {
  return regex.some((re) => re.test(filePath));
}
