/**
 * Execution-config sub-types split out of runtime-types.ts (file-size limit).
 */

/** Flake-detection probe config — see src/verification/flake-probe.ts. */
export interface FlakeDetectionConfig {
  /** Enable isolation re-runs to distinguish deterministic failures from flakes. */
  enabled: boolean;
  /** Number of isolation re-runs per probe. */
  probeRuns: number;
  /** Upper bound on probes accumulated per gate. */
  maxProbesPerGate: number;
  /** Per-probe subprocess timeout in seconds. */
  probeTimeoutSeconds: number;
}

/** Mutation-check config (US-001) — opt-in mutation-testing spot-check. */
export interface MutationCheckConfig {
  /** Enable mutation-check spot-check after GREEN. Default false. */
  enabled: boolean;
  /** Max mutants generated per story (budget cap). */
  maxMutants: number;
  /** Per-mutant subprocess timeout in seconds. */
  timeoutSeconds: number;
}

/** Smart test runner configuration (STR-007) */
export interface SmartTestRunnerConfig {
  /** Enable smart test runner (default: true) */
  enabled: boolean;
  /**
   * Glob patterns to scan for test files during import-grep fallback.
   *
   * Optional — undefined means "user did not set this"; resolver falls through
   * to auto-detection then DEFAULT_TEST_FILE_PATTERNS. Explicit `[]` means
   * "no test files in this scope" (distinct from undefined). (ADR-009)
   */
  testFilePatterns?: string[];
  /** Fallback strategy when path-convention mapping yields no results */
  fallback: "import-grep" | "full-suite";
  /** Max test files scanned (post-filter) before truncating (default: 200) */
  maxScanFiles: number;
}
