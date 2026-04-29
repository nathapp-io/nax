/**
 * Shared heuristics for detecting test file content.
 *
 * Single source of truth consolidated from acceptance-setup stage and
 * acceptance/generator.ts. See ADR-020 Wave 3 Step 3.
 */

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
 * assertions only, no real test logic). Mirrors isStubTestFile in
 * src/execution/lifecycle/acceptance-helpers.ts — both must stay aligned.
 */
export function isStubTestContent(content: string): boolean {
  if (!/expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*(?:false|true)\s*\)/.test(content)) return false;
  return !/expect\s*\(\s*(?!(?:true|false)\b)[^\s)]/.test(content);
}
