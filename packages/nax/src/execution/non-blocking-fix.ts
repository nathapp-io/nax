/**
 * ADR-024 — Non-blocking best-effort adversarial fix.
 *
 * Runs after adversarial review passes. Reuses runRectification via overrides:
 * advisory findings as the seed, the LLM-review phases stripped from
 * revalidation, attempts bounded, and (scope "both" + verifierGuard) the
 * verifier added when a test edit occurs. On exhaustion, restores the
 * working tree AND phaseOutputs to the adversarial-passed snapshot.
 *
 * After a successful pass, enforces `sourceDiffCap` (maxFiles + maxLines) over
 * the source-only diff (test files excluded by the `measureSourceDiff` dep).
 * A best-effort pass that exceeds the cap is treated as exhausted → restored.
 * A pass that touched a `.nax/` control file is restored too — such files buy no
 * source count, and an agent that rewrote nax's own state must not be kept.
 * Measurement errors are fail-safe: also restored. Every restore names the
 * commits it discards (`listCommitsSince`).
 *
 * This module is the sequencer plus the public surface (types, deps defaults,
 * the small exported predicates). The phases themselves — prologue, keep
 * gauntlet, exhausted tail, restore — live in `non-blocking-fix-phases.ts`,
 * which imports this module TYPE-ONLY so the runtime edge stays
 * one-directional.
 */

import { isInside } from "@nathapp/nax-agent/internal";
import type { NonBlockingFixConfig } from "../config/selectors";
import { isRecurrenceRetired } from "../findings/retirement-stamp";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import type { FixReviewVerdict } from "../review/fix-review";
import { captureSnapshotRef, rollbackToRef } from "../tdd/rollback";
import type { QuarantineMemo } from "../verification";
import type { SourceDiffMetrics } from "./nbf-source-diff";
import { listCommitsSince } from "./nbf-source-diff";
import { beginNbfPass, finishExhausted, resolveKeepGates } from "./non-blocking-fix-phases";
import type { GateRegressionDetail, PhaseKind } from "./story-orchestrator";
import type { NbfFlakeTriageTransaction } from "./story-orchestrator/nbf-flake-triage";

/** Phase kinds to strip from revalidation — always the LLM reviews. */
const REVIEW_PHASE_KINDS = ["semantic-review", "adversarial-review"] as const satisfies readonly PhaseKind[];

/** Run the pass only when enabled and there is at least one advisory finding. */
export function shouldRunNonBlockingFix(cfg: NonBlockingFixConfig | undefined, advisoryCount: number): boolean {
  return cfg?.enabled === true && advisoryCount > 0;
}

/** Phases to strip from revalidation (always the LLM reviews). */
export function nonBlockingExcludePhases(): readonly PhaseKind[] {
  return REVIEW_PHASE_KINDS;
}

/** Extra revalidation phases: verifier when test edits are possible and guarded. */
export function nonBlockingExtraPhases(cfg: NonBlockingFixConfig): readonly PhaseKind[] {
  return (cfg.scope === "both" || cfg.scope === "triage") && cfg.verifierGuard ? ["verifier"] : [];
}

export type { SourceDiffMetrics, SourceDiffPaths } from "./nbf-source-diff";
export {
  _nonBlockingFixDeps,
  createMeasureSourceDiff,
  listCommitsSince,
  NBF_LOGGED_PATH_LIMIT,
} from "./nbf-source-diff";

export interface NonBlockingFixDeps {
  captureSnapshotRef: typeof captureSnapshotRef;
  rollbackToRef: typeof rollbackToRef;
  /**
   * SHAs in `workdir` committed since `ref`, newest first. Read just before a
   * restore so the discarded pass's commits are named in the restore log.
   * A rejection degrades to `[]` and the restore still proceeds.
   */
  listCommitsSince: (workdir: string, ref: string) => Promise<string[]>;
  /**
   * Measure source-only diff between the adversarial-passed ref and HEAD.
   * Test files must already be excluded by the implementation
   * (`resolveTestFilePatterns` is the ADR-009 SSOT). Errors propagate;
   * `runNonBlockingFix` treats them as "cap exceeded" (fail-safe).
   */
  measureSourceDiff: (workdir: string, fromRef: string) => Promise<SourceDiffMetrics>;
  /**
   * ADR-033 — the scoped fix review, run on a pass that would otherwise be kept.
   *
   * Called with the snapshot sha captured at entry (`restoreRef.sha`). A `pass`
   * keeps the pass as today; any other verdict (scope fail, contradiction,
   * dispatch/parse error) restores the adversarial-passed snapshot. Absent ⇒ no
   * review, keep as today (backward-compatible).
   *
   * STUB (test-writer RED state): declared so the acceptance tests compile.
   */
  reviewFix?: (preFixRef: string) => Promise<FixReviewVerdict>;
}

const DEFAULT_DEPS: NonBlockingFixDeps = {
  captureSnapshotRef,
  rollbackToRef,
  listCommitsSince,
  measureSourceDiff: async () => ({ fileCount: 0, sourceLineCount: 0 }),
};

export interface NonBlockingFixArgs {
  workdir: string;
  storyId: string;
  /**
   * Sub-threshold adversarial findings to seed the pass with.
   *
   * MUST already be filtered through `actionableAdvisoryFindings` — the caller owns
   * that because it also builds the `runRectify` closure these seed, so filtering here
   * would fix the gate while leaving the seed unfiltered. Passing the raw bucket
   * re-opens #1359: a pass gets dispatched for a finding that asked for nothing.
   */
  advisoryFindings: readonly Finding[];
  cfg: NonBlockingFixConfig;
  phaseOutputs: Record<string, unknown>;
  /**
   * Per-phase cost accumulator. The best-effort rectify pass mutates this in place
   * (same object the cycle accumulates into). Snapshotted at entry and restored on
   * rollback so a discarded pass leaves no trace in the result's cost breakdown —
   * symmetric with `phaseOutputs`. (True total spend still lives in the cost
   * middleware / CostAggregator, the SSOT; this is the diagnostic per-phase split.)
   */
  phaseCosts: Record<string, number>;
  /** Run-scoped memo; new NBF verdicts are buffered until the pass is kept. */
  quarantineMemo?: QuarantineMemo;
  /** Verifier-time failures excluded from NBF first-observation probing. */
  gateBaselineKeys?: ReadonlySet<string>;
  /**
   * Working trees holding source this run cannot account for — currently an
   * unreverted mutation from the mutation spot-check (`runtime.dirtyWorktrees`).
   *
   * NBF's very first act is a snapshot COMMIT, which would capture the injected
   * defect and, worse, leave the tree clean so every later `autoCommitIfDirty`
   * guard sees nothing to block. Skipping the pass is the only safe response.
   */
  blockedWorktrees?: ReadonlySet<string>;
  /** Runs the harness; returns true when it exhausted without resolving. */
  runRectify: (
    maxAttempts: number,
    flakeTriage: NbfFlakeTriageTransaction,
  ) => Promise<{ rectificationExhausted?: boolean }>;
  /**
   * Reports whether the KEPT working tree regressed the deterministic full-suite
   * gate relative to the adversarial-passed baseline. ADR-024 §3: a deterministic
   * red must revert, never ship.
   *
   * `rectificationExhausted` alone is insufficient: the inner rectify cycle can
   * return not-exhausted via the verifier-SSOT exemption (verifier passed ⇒ gate
   * red treated as pre-existing) even while its own revalidation left the full-suite
   * gate red. Keeping that fix then trips the downstream staleness guard in
   * `ExecutionPlan.run`, which fails the story — breaking the §1/§5 "can never fail
   * the story" floor. The caller wires this to the SAME staleness predicate the final
   * verdict uses, so the keep-decision and the verdict can never disagree.
   *
   * Returns the DETAIL rather than a bare boolean so the restore can name what
   * regressed (#1382): a bare `true` produced a revert an operator could not
   * distinguish from a flake or a pre-existing failure, and the evidence was gone
   * by the time they looked (`phaseOutputs` wiped here, the edit hard-reset away).
   * A single detail-returning predicate — rather than a second `describeGateRegression`
   * dep — keeps the verdict and its explanation from ever disagreeing.
   *
   * Absent ⇒ no gate check (backward-compatible).
   */
  keptTreeRegressed?: (quarantineMemo?: QuarantineMemo) => GateRegressionDetail;
}

export interface NonBlockingFixResult {
  ran: boolean;
  kept: boolean;
  restored: boolean;
}

/**
 * Is `workdir` the blocked working tree, or a package inside one?
 *
 * One-directional on purpose. `blockedWorktrees` holds working-tree ROOTS, and
 * `isInside` already treats the root itself as inside, so this covers both the
 * root and any package under it. The reverse test (a blocked root inside
 * `workdir`) would fire when `workdir` is the main repo and some story's linked
 * worktree at `<repo>/.nax-wt/<storyId>` is blocked — a separate checkout whose
 * state says nothing about this one.
 */
function isBlocked(blocked: ReadonlySet<string>, workdir: string): boolean {
  return [...blocked].some((tree) => isInside(tree, workdir));
}

/**
 * Snapshot → run harness → keep on success, restore (files + phaseOutputs) on
 * exhaustion. Never throws into the caller's verdict path: failure ⇒ restore ⇒
 * the story keeps its adversarial-passed state.
 *
 * Sequencer only: the two entry guards below, then the phases from
 * `non-blocking-fix-phases.ts` — the prologue (`beginNbfPass`) decides
 * not-ran / exhausted / pass, the keep gauntlet (`resolveKeepGates`)
 * adjudicates a pass, and the exhausted tail (`finishExhausted`) restores.
 */
export async function runNonBlockingFix(
  args: NonBlockingFixArgs,
  overrides: Partial<NonBlockingFixDeps> = {},
): Promise<NonBlockingFixResult> {
  const _deps: NonBlockingFixDeps = { ...DEFAULT_DEPS, ...overrides };
  const logger = getSafeLogger();
  if (!shouldRunNonBlockingFix(args.cfg, args.advisoryFindings.length)) {
    return { ran: false, kept: false, restored: false };
  }
  // Checked before the snapshot, not after: the snapshot is itself a commit, so
  // by the time it has run the mutation is already captured and the tree is
  // clean. Degrades to "nbf did not run", matching the snapshot-failure path.
  if (args.blockedWorktrees?.size && isBlocked(args.blockedWorktrees, args.workdir)) {
    logger?.warn("non-blocking-fix", "skipping best-effort pass — worktree may hold an unreverted mutation", {
      storyId: args.storyId,
      workdir: args.workdir,
    });
    return { ran: false, kept: false, restored: false };
  }
  const begin = await beginNbfPass(args, _deps, logger);
  if (begin.kind === "not-ran") return { ran: false, kept: false, restored: false };
  if (begin.kind === "exhausted") return finishExhausted(begin.frame);
  const restoreResult = await resolveKeepGates(begin.frame);
  if (restoreResult) return restoreResult;
  begin.frame.flakeTriage.commit();
  logger?.info("non-blocking-fix", "best-effort fix kept", { storyId: args.storyId });
  return { ran: true, kept: true, restored: false };
}

/**
 * Advisory findings that actually ask for a change.
 *
 * NBF seeds from the adversarial advisory bucket and used to apply no filter at all, so
 * a finding whose own suggestion read "No action needed; this is the intended behaviour"
 * still opened a pass: on otel-telemetry-expansion US-004 that dispatched a paid
 * implementer session against a compliance confirmation, broke a test, and was rolled
 * back for zero net change (#1359).
 *
 * Absent `actionRequired` counts as actionable — every producer predating #1359 omits
 * it, and defaulting the other way would silence the whole feature.
 *
 * Applied at the SEEDING site only, never in the reviewer's own output: the end-of-run
 * advisory report reads the op's `advisoryFindings` (`review-audit.ts`), and filtering
 * there would delete the very visibility that made this diagnosable.
 *
 * #1966 — a finding stamped `meta.recurrence.disposition === "retired"` is
 * TERMINAL advisory: the advisory cap has been reached and the carry-forward
 * prompt renders it in the acknowledgement section as "closed, do not re-flag"
 * (US-004). Re-seeding it into NBF would re-introduce the very loop retirement
 * exists to break — a paid implementer session dispatched against a finding the
 * reviewer has been told to stop re-raising. The end-of-run report still reads
 * `advisoryFindings` directly (the unfiltered bucket), so a retired finding is
 * still reported; it is only its fix-lane eligibility that changes.
 */
export function actionableAdvisoryFindings(findings: readonly Finding[]): readonly Finding[] {
  // #1950 — AC-quote drops are folded into advisoryFindings so they reach the
  // end-of-run report, but they do not buy an agent session. This is a HOLD on
  // #1801 (may an AC-ungrounded finding drive action?), not a claim that drops
  // are weak: all three in the corpus are substantive and one shipped (#1951).
  // Seeding them would settle #1801 through a side door. See `Finding.acDropped`.
  return findings.filter((f) => {
    if (f.actionRequired === false) return false;
    if (f.acDropped === true) return false;
    if (isRecurrenceRetired(f)) return false;
    return true;
  });
}
