/**
 * Detection types — shared by all detect sub-modules.
 * Extracted here to avoid circular imports between detect.ts and detect/index.ts.
 */

/** Single detection signal source (one tier result) */
export interface DetectionSource {
  type: "framework-config" | "manifest" | "file-scan" | "directory";
  /**
   * Framework identifier (e.g. "jest", "vitest", "playwright", "pytest").
   * Present on Tier 1 and Tier 2 sources. Used by the orchestrator to suppress
   * Tier 2 defaults when Tier 1 has already claimed the same framework — even
   * when Tier 1 yielded no extractable patterns (e.g. testRegex, dynamic config).
   */
  framework?: string;
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
