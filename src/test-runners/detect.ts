/**
 * Test File Pattern Detection — Phase 1 Stub
 *
 * Phase 1 always returns empty confidence; the resolver falls through to
 * DEFAULT_TEST_FILE_PATTERNS. Phase 2 replaces this with four-tier signal
 * detection (framework configs → framework defaults → file scan → directory
 * conventions) and a mtime-based cache in `.nax/cache/test-patterns.json`.
 *
 * Injectable `_detectDeps` follows the project `_deps` pattern (mock.module()
 * is banned — see `.claude/rules/forbidden-patterns.md`).
 */

/** Single detection signal source (one tier result) */
export interface DetectionSource {
  type: "framework-config" | "manifest" | "file-scan" | "directory";
  path: string;
  patterns: readonly string[];
}

/**
 * Result of running auto-detection on a workdir.
 *
 * `confidence` reflects the strongest tier that yielded patterns:
 * - `"high"`   — Tier 1 (framework config file, e.g. vitest.config.ts)
 * - `"medium"` — Tier 2 (framework in devDependencies, using framework defaults)
 * - `"low"`    — Tier 3 / Tier 4 (file scan or directory convention)
 * - `"empty"`  — No signals found; caller falls through to DEFAULT_TEST_FILE_PATTERNS
 */
export interface DetectionResult {
  patterns: readonly string[];
  confidence: "high" | "medium" | "low" | "empty";
  sources: readonly DetectionSource[];
}

/** Injectable deps for testability — Phase 2 will populate with spawn + fs reads */
export const _detectDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
  file: Bun.file as typeof Bun.file,
};

/**
 * Detect test file patterns for the given working directory.
 *
 * Phase 1 stub: always returns `{ confidence: "empty", patterns: [], sources: [] }`.
 * The resolver falls through to DEFAULT_TEST_FILE_PATTERNS on empty confidence.
 *
 * Phase 2 replaces this with real four-tier detection.
 */
// biome-ignore lint/correctness/noUnusedFunctionParameters: workdir used by Phase 2 implementation
export async function detectTestFilePatterns(_workdir: string): Promise<DetectionResult> {
  return { patterns: [], confidence: "empty", sources: [] };
}
