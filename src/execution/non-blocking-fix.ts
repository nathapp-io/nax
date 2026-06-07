/**
 * ADR-024 — Non-blocking best-effort adversarial fix.
 *
 * Runs after adversarial review passes. Reuses runRectification via overrides:
 * advisory findings as the seed, the LLM-review phases stripped from
 * revalidation, attempts bounded, and (scope "both" + verifierGuard) the
 * verifier added when a test edit occurs. On exhaustion, restores the
 * working tree AND phaseOutputs to the adversarial-passed snapshot.
 */
import type { NonBlockingFixConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import { captureSnapshotRef, rollbackToRef } from "../tdd/rollback";
import type { PhaseKind } from "./story-orchestrator";

/** Phase kinds to strip from revalidation — always the LLM reviews. */
const REVIEW_PHASE_KINDS = ["semantic-review", "adversarial-review"] as const satisfies readonly PhaseKind[];

/** Run the pass only when enabled and there is at least one advisory finding. */
export function shouldRunNonBlockingFix(
  cfg: NonBlockingFixConfig | undefined,
  advisoryCount: number,
): boolean {
  return cfg?.enabled === true && advisoryCount > 0;
}

/** Phases to strip from revalidation (always the LLM reviews). */
export function nonBlockingExcludePhases(): readonly PhaseKind[] {
  return REVIEW_PHASE_KINDS;
}

/** Extra revalidation phases: verifier when test edits are possible and guarded. */
export function nonBlockingExtraPhases(cfg: NonBlockingFixConfig): readonly PhaseKind[] {
  return cfg.scope === "both" && cfg.verifierGuard ? ["verifier"] : [];
}

export interface NonBlockingFixDeps {
  captureSnapshotRef: typeof captureSnapshotRef;
  rollbackToRef: typeof rollbackToRef;
}

const DEFAULT_DEPS: NonBlockingFixDeps = { captureSnapshotRef, rollbackToRef };

export interface NonBlockingFixArgs {
  workdir: string;
  storyId: string;
  advisoryFindings: readonly Finding[];
  cfg: NonBlockingFixConfig;
  phaseOutputs: Record<string, unknown>;
  /** Runs the harness; returns true when it exhausted without resolving. */
  runRectify: (maxAttempts: number) => Promise<{ rectificationExhausted?: boolean }>;
}

export interface NonBlockingFixResult {
  ran: boolean;
  kept: boolean;
  restored: boolean;
}

/**
 * Snapshot → run harness → keep on success, restore (files + phaseOutputs) on
 * exhaustion. Never throws into the caller's verdict path: failure ⇒ restore ⇒
 * the story keeps its adversarial-passed state.
 */
export async function runNonBlockingFix(
  args: NonBlockingFixArgs,
  _deps: NonBlockingFixDeps = DEFAULT_DEPS,
): Promise<NonBlockingFixResult> {
  const logger = getSafeLogger();
  if (!shouldRunNonBlockingFix(args.cfg, args.advisoryFindings.length)) {
    return { ran: false, kept: false, restored: false };
  }
  // Shallow copy is sufficient: phase outputs are replaced wholesale by each stage,
  // never mutated in place.
  const phaseOutputsSnapshot = { ...args.phaseOutputs };
  const restoreRef = await _deps.captureSnapshotRef(args.workdir, args.storyId);
  const maxAttempts = 1 + args.cfg.regressionAttempts;

  let exhausted = false;
  try {
    const result = await args.runRectify(maxAttempts);
    exhausted = result.rectificationExhausted === true;
  } catch (err) {
    logger?.warn("non-blocking-fix", "best-effort pass threw — restoring", {
      storyId: args.storyId,
      error: err instanceof Error ? err.message : String(err),
    });
    exhausted = true;
  }

  if (!exhausted) {
    logger?.info("non-blocking-fix", "best-effort fix kept", { storyId: args.storyId });
    return { ran: true, kept: true, restored: false };
  }

  await _deps.rollbackToRef(args.workdir, restoreRef);
  // In-place restore required: ExecutionPlan.run holds a direct reference to phaseOutputs;
  // returning a new object would leave the caller with stale gate/verifier results from
  // the failed best-effort pass. Intentional exception to the immutability rule.
  for (const key of Object.keys(args.phaseOutputs)) delete args.phaseOutputs[key];
  Object.assign(args.phaseOutputs, phaseOutputsSnapshot);
  logger?.info("non-blocking-fix", "best-effort fix exhausted — restored to adversarial-passed", {
    storyId: args.storyId,
  });
  return { ran: true, kept: false, restored: true };
}
