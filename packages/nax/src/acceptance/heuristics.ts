/**
 * Shared heuristics for detecting test file content.
 *
 * Single source of truth consolidated from acceptance-setup stage and
 * acceptance/generator.ts. See ADR-020 Wave 3 Step 3.
 */

/**
 * Marker `generateSkeletonTests` writes into every skeleton it emits, in each
 * language's comment syntax.
 *
 * Skeleton detection is deliberately exact rather than heuristic. A positive
 * makes the stub guard regenerate — `regenerateAcceptanceTest` copies the file
 * to `.bak`, unlinks it and drops acceptance-meta.json, and nothing ever
 * restores the `.bak` — so a false positive destroys a real suite. Inferring
 * "stub" from placeholder shapes (`pytest.fail`, `t.Fatal`, `panic!`) cannot
 * be made safe: those forms appear in genuine tests, and in any language they
 * can appear inside a fixture string in a file of some other language.
 * Watermarking what we generate has no false-positive class at all.
 */
export const SKELETON_WATERMARK = "nax:skeleton-acceptance-test";

/** Returns true when content looks like a test file (language-agnostic). */
export function hasLikelyTestContent(content: string): boolean {
  return (
    /\b(?:describe|test|it|expect)\s*\(/.test(content) ||
    /func\s+Test\w+\s*\(/.test(content) ||
    /def\s+test_\w+/.test(content) ||
    /#\[test\]/.test(content)
  );
}

/**
 * Returns true when content appears to be a skeleton stub test (placeholder
 * assertions only, no real test logic).
 *
 * Two independent signals:
 *
 * 1. The watermark, which covers every language `generateSkeletonTests` emits
 *    — Python, Go and Rust included (#1898; before this they went entirely
 *    unrecognised and stub recovery was inert for those projects).
 * 2. The original JS/TS `expect(true).toBe(...)` shape, kept because it also
 *    catches a *model* that emits placeholder assertions of its own, and
 *    because skeletons written by earlier nax versions carry no watermark.
 *
 * The equivalent shape-based signal for the other three languages is
 * deliberately absent — see SKELETON_WATERMARK for why it cannot be made safe.
 * A model emitting non-JS placeholders still fails the RED gate loudly rather
 * than silently, which is the tolerable direction.
 */
export function isStubTestContent(content: string): boolean {
  if (content.includes(SKELETON_WATERMARK)) return true;
  return isJsPlaceholderContent(content);
}

/** The original JS/TS form: `expect(true).toBe(...)` and no other real assertion. */
function isJsPlaceholderContent(content: string): boolean {
  if (!/expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*(?:false|true)\s*\)/.test(content)) return false;
  return !/expect\s*\(\s*(?!(?:true|false)\b)[^\s)]/.test(content);
}
