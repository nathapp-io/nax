/**
 * `finish` config types — the autonomous post-run finish flow (nax-finish).
 *
 * Split out of `runtime-types.ts`, which is at its file-size limit.
 */

/** Wall-clock budgets for the nax-finish flow's subprocesses (ms) */
export interface FinishTimeoutsConfig {
  acceptanceMs: number;
  gateMs: number;
  flowMs: number;
}

/** `finish.autoFlow` — the autonomous post-run finish flow (opt-in, off by default) */
export interface FinishAutoFlowConfig {
  enabled: boolean;
  /** Flow module path; relative paths resolve against the nax install, then the repo */
  flowPath: string;
  /** acpx `--default-agent` for nodes without a pinned profile */
  defaultAgent: string | null;
  /** Per-phase reviewer acpx profiles */
  reviewers: { spec: string | null; quality: string | null };
  escalate: { telegram: boolean };
  timeouts: FinishTimeoutsConfig;
}

/** `finish` config block */
export interface FinishConfig {
  autoFlow: FinishAutoFlowConfig;
}
