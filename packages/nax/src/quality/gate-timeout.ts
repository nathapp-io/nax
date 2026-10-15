/**
 * The one timeout for a full test-suite run: the run-start baseline, the
 * full-suite gate, and the agent's own `RunCommand` (nax#2536) all read it,
 * so the agent is never held to a shorter budget than the gate that judges it.
 */

/** Used only for a config slice with neither key; a parsed config always carries `regressionGate.timeoutSeconds` (schema default 120). */
export const DEFAULT_FULL_SUITE_TIMEOUT_SECONDS = 300;

/** The config keys the resolver reads; every member optional so any config slice fits. */
export interface FullSuiteTimeoutConfig {
  execution?: {
    regressionGate?: { timeoutSeconds?: number };
    rectification?: { fullSuiteTimeoutSeconds?: number };
  };
}

/**
 * `regressionGate.timeoutSeconds` wins (legacy RegressionStrategy, #1116);
 * `rectification.fullSuiteTimeoutSeconds` is the older key kept for callers
 * that still set only it.
 */
export function resolveFullSuiteTimeoutSeconds(config: FullSuiteTimeoutConfig | undefined): number {
  return (
    config?.execution?.regressionGate?.timeoutSeconds ??
    config?.execution?.rectification?.fullSuiteTimeoutSeconds ??
    DEFAULT_FULL_SUITE_TIMEOUT_SECONDS
  );
}
