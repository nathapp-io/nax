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

/** Worktree dependency preparation strategy (WT-DEPS-001) */
export interface WorktreeDependenciesConfig {
  /** How nax should prepare a fresh worktree before story execution */
  mode: "provision" | "off";
  /** Explicit provisioning command override (valid only in provision mode) */
  setupCommand?: string | null;
  /** Hard deadline (seconds) for the provisioning spawn (BUG-13) */
  timeoutSeconds: number;
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

/** Lifecycle-script gate for agent-triggered installs (`install.allowScripts`). */
export interface InstallConfig {
  /**
   * Lifecycle scripts are off for agent-triggered installs.
   *
   * A postinstall script is arbitrary code from a third party running in the
   * user's repo with the user's environment. nax appends the manager's
   * no-scripts flag, and the model cannot remove it because nax builds the
   * argv. A repo that genuinely needs native builds opts out here, in config
   * a human wrote and a reviewer can grep for. (default: false)
   */
  allowScripts: boolean;
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
