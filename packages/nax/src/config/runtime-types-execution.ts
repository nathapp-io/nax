/**
 * Execution-config sub-types split out of runtime-types.ts (file-size limit).
 */

/** Worktree dependency preparation strategy (WT-DEPS-001) */
export interface WorktreeDependenciesConfig {
  /** How nax should prepare a fresh worktree before story execution */
  mode: "provision" | "off";
  /** Explicit provisioning command override (valid only in provision mode) */
  setupCommand?: string | null;
  /** Hard deadline (seconds) for the provisioning spawn (BUG-13) */
  timeoutSeconds: number;
}

/**
 * One blocking host-side pre-run step (`execution.preRun`, US-003): a shell
 * command the *host* runs once per run, before baseline capture and story
 * dispatch, for setup an agent's sandboxed session cannot do (starting a
 * service the tests need). The optional user timeout is resolved to
 * `timeoutSeconds` by the schema.
 */
export interface PreRunStepConfig {
  /** Shell command, run with `/bin/sh -c` from the run workdir. */
  readonly command: string;
  /** Hard deadline in seconds. */
  readonly timeoutSeconds: number;
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

/** Command interception (rtk git-site) — opt-in; installed into the Git tool seam at run setup. */
export interface CommandInterceptorConfig {
  /**
   * Opt-in (R7): interception changes what the agent sees, so it must not
   * switch on merely because the provider binary is installed.
   */
  enabled: boolean;
  /**
   * Measured git verbs to intercept: `log` and `diff` by default (US-001 run
   * 4). Read the results doc before changing this list.
   */
  git: {
    verbs: string[];
  };
  /**
   * Opt-in for the BASH site (US-002): the model-authored command string is
   * routed through the provider's `rewrite` before it runs. Independent of the
   * Git site — `enabled` is the master switch and this one requires it.
   */
  bash: {
    enabled: boolean;
  };
}
