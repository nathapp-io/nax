import { NaxError } from "../errors";
import type { FinishAdvisor } from "./advise";
import type { AuditTarget } from "./audit";
import type { FinishContext } from "./context";
import type { FixStepDeps } from "./fix-step";
import type { FinishOps } from "./ops";
import type { FinishTimeouts } from "./types";

export interface FinishMachineDeps {
  context: FinishContext;
  ops: FinishOps;
  audit: AuditTarget;
  /** The run's signal plus the phase's own `flowMs` deadline. */
  signal?: AbortSignal;
  /**
   * The *run's* signal, distinct from `signal` (which also carries the phase's
   * `flowMs` deadline). A run the user cancelled ends `failed` with no forge
   * call; a deadline still finalizes a draft PR, so the two cannot be collapsed.
   */
  runSignal?: AbortSignal;
  /** Injected so tests can assert round ordering deterministically. */
  now: () => string;
  /** A1 advisor (judged findings + approval). Absent: no advisor, deterministic fallbacks. */
  advise?: FinishAdvisor | undefined;
  timeouts?: FinishTimeouts;
  /** Run output dir; where A3's worth-check records live. Absent: no hints. */
  outputDir?: string;
}

/** Checked at the top of every loop iteration and before each `ops.*` call (I6). */
export function assertNotAborted(deps: Pick<FinishMachineDeps, "signal">): void {
  if (deps.signal?.aborted) {
    throw new NaxError("Finish aborted mid-loop", "FINISH_ABORTED", { stage: "finish" });
  }
}

/** The `runFixStep` deps a loop passes, from the machine deps. */
export function fixStepDeps(deps: FinishMachineDeps): FixStepDeps {
  return {
    ops: deps.ops,
    audit: deps.audit,
    now: deps.now,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.runSignal ? { runSignal: deps.runSignal } : {}),
    ...(deps.timeouts?.fixMs !== undefined ? { fixMs: deps.timeouts.fixMs } : {}),
    ...(deps.timeouts?.flowMs !== undefined ? { flowMs: deps.timeouts.flowMs } : {}),
  };
}
