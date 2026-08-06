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
  /** Per flow step, forwarded to acpx as `--timeout`; null keeps acpx's own default */
  stepMs: number | null;
}

/** `finish.autoFlow` — the autonomous post-run finish flow (opt-in, off by default) */
export interface FinishAutoFlowConfig {
  enabled: boolean;
  /** Flow module path; relative paths resolve against the nax install, then the repo */
  flowPath: string;
  /** acpx `--default-agent` for nodes without a pinned profile */
  defaultAgent: string | null;
  /** acpx `--model` — a run-wide fallback below `node.model` and `agent.model`; null passes no flag */
  model: string | null;
  /** Whether the flow writes the PR body's "What changed" narrative */
  narrative: boolean;
  /** Per-node acpx profiles */
  reviewers: { spec: string | null; quality: string | null; narrative: string | null };
  escalate: { telegram: boolean };
  timeouts: FinishTimeoutsConfig;
}

/** `finish` config block */
export interface FinishConfig {
  autoFlow: FinishAutoFlowConfig;
}
