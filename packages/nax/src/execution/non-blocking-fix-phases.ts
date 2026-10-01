/**
 * ADR-024 — the `runNonBlockingFix` phases, extracted from
 * `non-blocking-fix.ts` (complexity drain batch A11).
 *
 * The function is a guard-chain plus a keep-gauntlet: prologue (snapshots,
 * rollback point, the rectify pass), then — only on a resolved pass — a
 * sequence of keep gates (full-suite gate regression, `sourceDiffCap`,
 * scoped fix review), each of which either restores the adversarial-passed
 * snapshot or lets the pass through to `flakeTriage.commit()`. The exhausted
 * tail restores too, naming the regressing identities first (#1382/#1401).
 *
 * Every phase takes and returns the same `NbfFrame` — the values fixed for the
 * run's lifetime (args, deps, logger, snapshots, the rollback ref, the triage
 * transaction) — so `args.phaseOutputs` / `args.phaseCosts` keep being
 * restored IN PLACE through the caller's own references (see
 * `restoreToSnapshot`). Imports from `non-blocking-fix.ts` are TYPE-ONLY: the
 * runtime edge must stay one-directional (sequencer -> phases) or the module
 * graph cycles.
 */

import type { getSafeLogger } from "../logger";
import type { FixReviewVerdict } from "../review/fix-review";
import type { SnapshotRef } from "../tdd/rollback";
import type { SourceDiffMetrics } from "./nbf-source-diff";
import { NBF_LOGGED_PATH_LIMIT } from "./nbf-source-diff";
import type { NonBlockingFixArgs, NonBlockingFixDeps, NonBlockingFixResult } from "./non-blocking-fix";
import type { GateRegressionDetail } from "./story-orchestrator";
import { createNbfFlakeTriageTransaction, type NbfFlakeTriageTransaction } from "./story-orchestrator/nbf-flake-triage";

/**
 * How many regressing test identities to sample into the rollback log. An unbounded
 * list dwarfs every other field in the JSONL record when a whole suite goes red;
 * `regressedKeyCount` carries the true magnitude alongside the sample.
 */
const MAX_LOGGED_REGRESSED_KEYS = 10;

/**
 * The values fixed for one `runNonBlockingFix` invocation, after the rollback
 * point exists. Every phase reads the run's inputs and injectable deps through
 * the frame; `deps` is the entry-merged `{ ...DEFAULT_DEPS, ...overrides }`, so
 * test overrides land exactly as before the split.
 */
interface NbfFrame {
  args: NonBlockingFixArgs;
  deps: NonBlockingFixDeps;
  logger: ReturnType<typeof getSafeLogger>;
  restoreRef: SnapshotRef;
  phaseOutputsSnapshot: Record<string, unknown>;
  phaseCostsSnapshot: Record<string, number>;
  flakeTriage: NbfFlakeTriageTransaction;
}

/** What the prologue decided: not-ran (no rollback point), exhausted, or a pass to adjudicate. */
type BeginPassOutcome =
  | { kind: "not-ran" }
  | { kind: "exhausted"; frame: NbfFrame }
  | { kind: "pass"; frame: NbfFrame };

/**
 * Prologue: snapshot both accumulators, capture the rollback point, run the
 * best-effort pass. A capture failure degrades to "nbf did not run" — the pass
 * has no safe undo (module contract: never throws into the caller's verdict
 * path). Returns which exit the sequencer must take plus the frame the other
 * exits share.
 */
async function beginNbfPass(
  args: NonBlockingFixArgs,
  deps: NonBlockingFixDeps,
  logger: ReturnType<typeof getSafeLogger>,
): Promise<BeginPassOutcome> {
  // Shallow copy is sufficient: phase outputs are replaced wholesale by each stage,
  // never mutated in place. phaseCosts is a flat number map — a shallow copy is a full
  // snapshot. Both are restored together on rollback so a discarded pass leaves no trace.
  const phaseOutputsSnapshot = { ...args.phaseOutputs };
  const phaseCostsSnapshot = { ...args.phaseCosts };

  // The snapshot ref is the rollback point. If it cannot be captured (non-git workdir,
  // detached/transient git failure), the best-effort pass has no safe undo, so skip it
  // entirely rather than throw. This honours the module contract — "never throws into the
  // caller's verdict path": a snapshot failure must degrade to "nbf did not run", never to
  // a hard story failure. The capture sat OUTSIDE the rectify try/catch in the monolith
  // for the same reason — its throw must not propagate into ExecutionPlan.run(). (Audit #1.)
  let restoreRef: SnapshotRef;
  try {
    restoreRef = await deps.captureSnapshotRef(args.workdir, args.storyId);
  } catch (err) {
    logger?.warn("non-blocking-fix", "snapshot capture failed — skipping best-effort pass (no rollback point)", {
      storyId: args.storyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "not-ran" };
  }
  const maxAttempts = 1 + args.cfg.regressionAttempts;
  const flakeTriage = createNbfFlakeTriageTransaction({
    baseMemo: args.quarantineMemo,
    baselineKeys: args.gateBaselineKeys ?? new Set(),
  });
  const frame: NbfFrame = { args, deps, logger, restoreRef, phaseOutputsSnapshot, phaseCostsSnapshot, flakeTriage };

  let exhausted = false;
  try {
    const result = await args.runRectify(maxAttempts, flakeTriage);
    exhausted = result.rectificationExhausted === true;
  } catch (err) {
    logger?.warn("non-blocking-fix", "best-effort pass threw — restoring", {
      storyId: args.storyId,
      error: err instanceof Error ? err.message : String(err),
    });
    exhausted = true;
  }

  return exhausted ? { kind: "exhausted", frame } : { kind: "pass", frame };
}

/**
 * Emit the #1382 regression evidence: which test identities the pass is being blamed for.
 *
 * Shared by both restore paths — the gate-regressed keep-decision and the exhausted tail —
 * because they must report the same fields. `flakeTriageRan` comes from the pass's
 * transaction-local triage state rather than a restore-path constant (#1404).
 */
interface LogGateRegressionInput {
  logger: ReturnType<typeof getSafeLogger>;
  storyId: string;
  message: string;
  verdict: GateRegressionDetail;
  flakeTriageRan: boolean;
}

function logGateRegression(input: LogGateRegressionInput): void {
  const { logger, storyId, message, verdict, flakeTriageRan } = input;
  logger?.info("non-blocking-fix", message, {
    storyId,
    regressedKeys: verdict.regressedKeys.slice(0, MAX_LOGGED_REGRESSED_KEYS),
    regressedKeyCount: verdict.regressedKeys.length,
    baselineKeySize: verdict.baselineKeySize,
    // True ⇒ execution-failure (or timeout, which yields no findings at all), so
    // `regressedKeys` is empty because there was no identity to capture, NOT because
    // nothing regressed.
    keyless: verdict.keyless,
    // Failures excluded as already-quarantined flakes (#1383).
    memoExcludedKeyCount: verdict.memoExcludedKeys.length,
    flakeTriageRan,
  });
}

/**
 * The restore itself: name the commits about to be discarded, roll the tree
 * back, and put BOTH accumulators back in place. In-place restore required:
 * ExecutionPlan.run holds a direct reference to phaseOutputs and phaseCosts;
 * returning new objects would leave the caller with stale gate/verifier results
 * and inflated costs from the failed best-effort pass. Intentional exception to
 * the immutability rule. Cost is restored alongside outputs so the result's
 * per-phase breakdown stays symmetric with its outputs after a discarded pass.
 */
async function restoreToSnapshot(frame: NbfFrame): Promise<NonBlockingFixResult> {
  const { args, deps, logger, restoreRef } = frame;
  // Name what is about to be discarded before the reset hides it. A failure to
  // list commits is not a reason to skip the restore — it degrades to [].
  let discardedCommits: string[] = [];
  try {
    discardedCommits = await deps.listCommitsSince(args.workdir, restoreRef.sha);
  } catch {
    discardedCommits = [];
  }
  await deps.rollbackToRef(args.workdir, restoreRef.sha, restoreRef.untrackedBefore);
  for (const key of Object.keys(args.phaseOutputs)) delete args.phaseOutputs[key];
  Object.assign(args.phaseOutputs, frame.phaseOutputsSnapshot);
  for (const key of Object.keys(args.phaseCosts)) delete args.phaseCosts[key];
  Object.assign(args.phaseCosts, frame.phaseCostsSnapshot);
  logger?.info("non-blocking-fix", "best-effort fix exhausted — restored to adversarial-passed", {
    storyId: args.storyId,
    discardedCommits,
  });

  return { ran: true, kept: false, restored: true };
}

/**
 * The sourceDiffCap half of the keep gauntlet. A pass whose source edits exceed
 * the cap is treated as exhausted → restored (fail-safe); a measurement error
 * restores too. Returns the restore result when the pass must not be kept,
 * `null` to let the gauntlet continue.
 */
async function enforceSourceDiffCap(frame: NbfFrame): Promise<NonBlockingFixResult | null> {
  const { args, deps, logger, restoreRef } = frame;
  const cap = args.cfg.sourceDiffCap;
  if (!cap) return null;
  let metrics: SourceDiffMetrics;
  try {
    metrics = await deps.measureSourceDiff(args.workdir, restoreRef.sha);
  } catch (err) {
    logger?.warn("non-blocking-fix", "source-diff measurement threw — restoring", {
      storyId: args.storyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return restoreToSnapshot(frame);
  }
  // A pass that touched nax's own control files never counts against the cap,
  // but it must never be kept either: restoring them (and saying so) is the
  // only safe outcome. Checked before the cap comparison so the control-path
  // log always wins.
  const controlPaths = metrics.controlPaths ?? [];
  if (controlPaths.length > 0) {
    logger?.warn("non-blocking-fix", "NBF pass touched nax control files — restoring", {
      storyId: args.storyId,
      controlPathCount: controlPaths.length,
      controlPaths: controlPaths.slice(0, NBF_LOGGED_PATH_LIMIT),
    });
    return restoreToSnapshot(frame);
  }
  const paths = metrics.paths ?? { added: [], modified: [], deleted: [] };
  if (metrics.fileCount > cap.maxFiles || metrics.sourceLineCount > cap.maxLines) {
    logger?.info("non-blocking-fix", "source diff exceeded cap — restoring", {
      storyId: args.storyId,
      fileCount: metrics.fileCount,
      sourceLineCount: metrics.sourceLineCount,
      cap,
      added: paths.added.slice(0, NBF_LOGGED_PATH_LIMIT),
      modified: paths.modified.slice(0, NBF_LOGGED_PATH_LIMIT),
      deleted: paths.deleted.slice(0, NBF_LOGGED_PATH_LIMIT),
      addedCount: paths.added.length,
      modifiedCount: paths.modified.length,
      deletedCount: paths.deleted.length,
    });
    return restoreToSnapshot(frame);
  }
  return null;
}

/**
 * The rejection log's data literal: the verdict's identity, plus the cause
 * detail only a `fail` carries — the out-of-scope files, or the contradiction's
 * acceptance criterion and file when the verdict names them.
 */
function reviewRejectionData(storyId: string, verdict: FixReviewVerdict): Record<string, unknown> {
  const data: Record<string, unknown> = {
    storyId,
    kind: verdict.kind,
    reason: verdict.reason,
  };
  if (verdict.kind === "fail") {
    data.cause = verdict.cause;
    if (verdict.cause === "scope") {
      data.files = verdict.files;
    } else if (verdict.cause === "contradiction") {
      if (verdict.acIndex !== undefined) data.acIndex = verdict.acIndex;
      if (verdict.file !== undefined) data.file = verdict.file;
    }
  }
  return data;
}

/**
 * ADR-033 — scoped fix review on a pass that would otherwise be kept. A
 * `pass` keeps the pass as today; any other verdict (scope fail,
 * contradiction, dispatch/parse error) restores the adversarial-passed
 * snapshot. Absent `reviewFix` ⇒ no review, keep as today.
 *
 * Wrapped in try/catch for the same reason `runRectify` and `measureSourceDiff`
 * are: `runFixReview` runs `resolveTestFilePatterns` and `truncateDiff`
 * outside any try (`src/review/fix-review/run/index.ts`), and an injected stub
 * `reviewFix` can also throw. Honoring the module contract — never throws into
 * the caller's verdict path — a throw degrades to a restore, the same way the
 * neighboring paths do.
 */
async function reviewKeptPass(frame: NbfFrame): Promise<NonBlockingFixResult | null> {
  const { args, deps, logger, restoreRef } = frame;
  if (!deps.reviewFix) return null;
  let verdict: FixReviewVerdict;
  try {
    verdict = await deps.reviewFix(restoreRef.sha);
  } catch (err) {
    logger?.warn("non-blocking-fix", "fix review threw — restoring", {
      storyId: args.storyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return restoreToSnapshot(frame);
  }
  if (verdict.kind !== "pass") {
    logger?.info(
      "non-blocking-fix",
      "fix review rejected the pass — restoring",
      reviewRejectionData(args.storyId, verdict),
    );
    return restoreToSnapshot(frame);
  }
  return null;
}

/**
 * The keep gauntlet for a resolved pass: the deterministic full-suite gate,
 * then the source diff cap, then the scoped fix review. Each gate logs its own
 * verdict and restores through the shared restore; falling through all three
 * means the pass is kept. Returns the restore result, or `null` when the pass
 * survives every gate.
 */
async function resolveKeepGates(frame: NbfFrame): Promise<NonBlockingFixResult | null> {
  const { args, logger, flakeTriage } = frame;
  // ADR-024 §3: a deterministic red in the pass's own revalidation must revert,
  // not ship. `rectificationExhausted` is insufficient — the inner cycle can report
  // resolved via the verifier-SSOT exemption while leaving the full-suite gate red.
  // Reuse the caller's staleness predicate (identical to the final verdict's) so a
  // "kept then failed by the downstream guard" contradiction is impossible.
  const gateVerdict = args.keptTreeRegressed?.(flakeTriage.memo);
  if (gateVerdict?.regressed) {
    // Name the regressing identities here: this is the only point where they exist.
    // `restoreToSnapshot` clears `phaseOutputs` (so the gate's rawOutput goes with it)
    // and `rollbackToRef` hard-resets the offending edit, leaving `git reflog` with
    // only the destination. Without this record the revert is unattributable (#1382).
    logGateRegression({
      logger,
      storyId: args.storyId,
      message: "kept tree regressed the full-suite gate — restoring (ADR-024 §3)",
      verdict: gateVerdict,
      flakeTriageRan: flakeTriage.flakeTriageRan,
    });
    return restoreToSnapshot(frame);
  }
  const capResult = await enforceSourceDiffCap(frame);
  if (capResult) return capResult;
  return reviewKeptPass(frame);
}

/**
 * The exhausted tail: restore, naming the regressing identities first when the
 * gate is red (#1382 parity — see the history note below).
 */
function finishExhausted(frame: NbfFrame): Promise<NonBlockingFixResult> {
  const { args, logger, flakeTriage } = frame;
  // #1382 parity on the exhausted path. Before #1401 the gate's regression was hidden
  // from the cycle, so a gate-red pass always exited "resolved" and the identity log
  // above was the only one that could fire. Now the cycle can see that regression and
  // spend `regressionAttempts` on it — and when the repair fails, the restore arrives
  // HERE instead, where the identities were never named. Without this the richer
  // diagnostic disappears in exactly the case an operator most needs it: a regression
  // real enough to survive a repair attempt. Read-only — `describeGateRegression` diffs
  // key sets already in `phaseOutputs` and re-runs nothing.
  //
  // Also reached when `runRectify` THREW (in the prologue), where `phaseOutputs` may hold a
  // half-finished sweep. The verdict is log-only and the restore happens regardless, so a
  // partial read is harmless — but the keys named on that path describe an aborted
  // validation, not a completed one.
  const exhaustedGateVerdict = args.keptTreeRegressed?.(flakeTriage.memo);
  if (exhaustedGateVerdict?.regressed) {
    logGateRegression({
      logger,
      storyId: args.storyId,
      message: "best-effort fix exhausted with the full-suite gate red",
      verdict: exhaustedGateVerdict,
      flakeTriageRan: flakeTriage.flakeTriageRan,
    });
  }

  return restoreToSnapshot(frame);
}

export { beginNbfPass, finishExhausted, resolveKeepGates };
