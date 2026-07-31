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
 * Measurement errors are fail-safe: also restored.
 */
import type { NonBlockingFixConfig, TestPatternConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import { captureSnapshotRef, rollbackToRef } from "../tdd/rollback";
import { createTestFileClassifier, resolveTestFilePatterns } from "../test-runners";
import { typedSpawn } from "../utils/bun-deps";
import { packageDirRelative } from "../utils/paths";
import type { GateRegressionDetail, PhaseKind } from "./story-orchestrator";

/** Phase kinds to strip from revalidation — always the LLM reviews. */
const REVIEW_PHASE_KINDS = ["semantic-review", "adversarial-review"] as const satisfies readonly PhaseKind[];

/**
 * How many regressing test identities to sample into the rollback log. An unbounded
 * list dwarfs every other field in the JSONL record when a whole suite goes red;
 * `regressedKeyCount` carries the true magnitude alongside the sample.
 */
const MAX_LOGGED_REGRESSED_KEYS = 10;

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
 */
export function actionableAdvisoryFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((f) => f.actionRequired !== false);
}

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

/**
 * Source-only diff metrics. Test files must already be excluded by the
 * `measureSourceDiff` implementation (e.g. via `resolveTestFilePatterns`).
 */
export interface SourceDiffMetrics {
  /** Number of changed source files (test files already excluded). */
  fileCount: number;
  /** Total added source lines across those files (test files already excluded). */
  sourceLineCount: number;
}

export interface NonBlockingFixDeps {
  captureSnapshotRef: typeof captureSnapshotRef;
  rollbackToRef: typeof rollbackToRef;
  /**
   * Measure source-only diff between the adversarial-passed ref and HEAD.
   * Test files must already be excluded by the implementation
   * (`resolveTestFilePatterns` is the ADR-009 SSOT). Errors propagate;
   * `runNonBlockingFix` treats them as "cap exceeded" (fail-safe).
   */
  measureSourceDiff: (workdir: string, fromRef: string) => Promise<SourceDiffMetrics>;
}

export const _nonBlockingFixDeps = {
  spawn: typedSpawn,
  resolveTestFilePatterns,
};

const DEFAULT_DEPS: NonBlockingFixDeps = {
  captureSnapshotRef,
  rollbackToRef,
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
  /** Runs the harness; returns true when it exhausted without resolving. */
  runRectify: (maxAttempts: number) => Promise<{ rectificationExhausted?: boolean }>;
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
  keptTreeRegressed?: () => GateRegressionDetail;
}

export interface NonBlockingFixResult {
  ran: boolean;
  kept: boolean;
  restored: boolean;
}

interface CreateMeasureSourceDiffArgs {
  config: TestPatternConfig;
  projectDir: string;
  packageDir: string;
}

export function createMeasureSourceDiff(args: CreateMeasureSourceDiffArgs): NonBlockingFixDeps["measureSourceDiff"] {
  const packageDirRel = packageDirRelative(args.projectDir, args.packageDir);
  return async (workdir: string, fromRef: string): Promise<SourceDiffMetrics> => {
    const resolved = await _nonBlockingFixDeps.resolveTestFilePatterns(args.config, args.projectDir, packageDirRel);
    const isTestFile = createTestFileClassifier(resolved);
    const proc = _nonBlockingFixDeps.spawn(["git", "diff", "--numstat", fromRef], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await Bun.readableStreamToText(proc.stdout);
    const stderr = await Bun.readableStreamToText(proc.stderr);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const detail = stderr.trim() || `exit ${exitCode}`;
      throw new Error(`[non-blocking-fix] git diff --numstat failed: ${detail}`);
    }

    let fileCount = 0;
    let sourceLineCount = 0;
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const [addedStr, _deletedStr, filePath] = line.split("\t");
      if (!filePath || isTestFile(filePath)) continue;
      fileCount += 1;
      const added = Number.parseInt(addedStr ?? "", 10);
      if (Number.isFinite(added)) sourceLineCount += added;
    }

    return { fileCount, sourceLineCount };
  };
}

/**
 * Snapshot → run harness → keep on success, restore (files + phaseOutputs) on
 * exhaustion. Never throws into the caller's verdict path: failure ⇒ restore ⇒
 * the story keeps its adversarial-passed state.
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
  // Shallow copy is sufficient: phase outputs are replaced wholesale by each stage,
  // never mutated in place. phaseCosts is a flat number map — a shallow copy is a full
  // snapshot. Both are restored together on rollback so a discarded pass leaves no trace.
  const phaseOutputsSnapshot = { ...args.phaseOutputs };
  const phaseCostsSnapshot = { ...args.phaseCosts };

  // The snapshot ref is the rollback point. If it cannot be captured (non-git workdir,
  // detached/transient git failure), the best-effort pass has no safe undo, so skip it
  // entirely rather than throw. This honours the module contract — "never throws into the
  // caller's verdict path": a snapshot failure must degrade to "nbf did not run", never to
  // a hard story failure. The capture sits OUTSIDE the rectify try/catch below, so without
  // this guard its throw would propagate straight through ExecutionPlan.run(). (Audit #1.)
  let restoreRef: string;
  try {
    restoreRef = await _deps.captureSnapshotRef(args.workdir, args.storyId);
  } catch (err) {
    logger?.warn("non-blocking-fix", "snapshot capture failed — skipping best-effort pass (no rollback point)", {
      storyId: args.storyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ran: false, kept: false, restored: false };
  }
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
    // ADR-024 §3: a deterministic red in the pass's own revalidation must revert,
    // not ship. `rectificationExhausted` is insufficient — the inner cycle can report
    // resolved via the verifier-SSOT exemption while leaving the full-suite gate red.
    // Reuse the caller's staleness predicate (identical to the final verdict's) so a
    // "kept then failed by the downstream guard" contradiction is impossible.
    const gateVerdict = args.keptTreeRegressed?.();
    if (gateVerdict?.regressed) {
      // Name the regressing identities here: this is the only point where they exist.
      // `restoreToSnapshot` clears `phaseOutputs` (so the gate's rawOutput goes with it)
      // and `rollbackToRef` hard-resets the offending edit, leaving `git reflog` with
      // only the destination. Without this record the revert is unattributable (#1382).
      logger?.info("non-blocking-fix", "kept tree regressed the full-suite gate — restoring (ADR-024 §3)", {
        storyId: args.storyId,
        regressedKeys: gateVerdict.regressedKeys.slice(0, MAX_LOGGED_REGRESSED_KEYS),
        regressedKeyCount: gateVerdict.regressedKeys.length,
        baselineKeySize: gateVerdict.baselineKeySize,
        // True ⇒ timeout / execution-failure, so `regressedKeys` is empty because there
        // was no identity to capture, NOT because nothing regressed.
        keyless: gateVerdict.keyless,
        // Failures excluded as already-quarantined flakes (#1383).
        memoExcludedKeyCount: gateVerdict.memoExcludedKeys.length,
        // Stated, not computed: this pass's revalidation gate is never flake-triaged —
        // triage owns the main gate path only (`rectification.ts`, the non-override
        // branch). So a FIRST-observation flake inside the revalidation window still
        // reads as a regression here, and an operator must be able to see that was
        // possible rather than infer a real break (#1383 option 3).
        flakeTriageRan: false,
      });
      return restoreToSnapshot(args, _deps, restoreRef, phaseOutputsSnapshot, phaseCostsSnapshot, logger);
    }
    // Enforce sourceDiffCap over the post-pass snapshot. A pass whose source
    // edits exceed the cap is treated as exhausted → restored (fail-safe).
    const cap = args.cfg.sourceDiffCap;
    if (cap) {
      let metrics: SourceDiffMetrics;
      try {
        metrics = await _deps.measureSourceDiff(args.workdir, restoreRef);
      } catch (err) {
        logger?.warn("non-blocking-fix", "source-diff measurement threw — restoring", {
          storyId: args.storyId,
          error: err instanceof Error ? err.message : String(err),
        });
        return restoreToSnapshot(args, _deps, restoreRef, phaseOutputsSnapshot, phaseCostsSnapshot, logger);
      }
      if (metrics.fileCount > cap.maxFiles || metrics.sourceLineCount > cap.maxLines) {
        logger?.info("non-blocking-fix", "source diff exceeded cap — restoring", {
          storyId: args.storyId,
          fileCount: metrics.fileCount,
          sourceLineCount: metrics.sourceLineCount,
          cap,
        });
        return restoreToSnapshot(args, _deps, restoreRef, phaseOutputsSnapshot, phaseCostsSnapshot, logger);
      }
    }
    logger?.info("non-blocking-fix", "best-effort fix kept", { storyId: args.storyId });
    return { ran: true, kept: true, restored: false };
  }

  // #1382 parity on the exhausted path. Before #1401 the gate's regression was hidden
  // from the cycle, so a gate-red pass always exited "resolved" and the identity log
  // above was the only one that could fire. Now the cycle can see that regression and
  // spend `regressionAttempts` on it — and when the repair fails, the restore arrives
  // HERE instead, where the identities were never named. Without this the richer
  // diagnostic disappears in exactly the case an operator most needs it: a regression
  // real enough to survive a repair attempt. Read-only — `describeGateRegression` diffs
  // key sets already in `phaseOutputs` and re-runs nothing.
  const exhaustedGateVerdict = args.keptTreeRegressed?.();
  if (exhaustedGateVerdict?.regressed) {
    logger?.info("non-blocking-fix", "best-effort fix exhausted with the full-suite gate red", {
      storyId: args.storyId,
      regressedKeys: exhaustedGateVerdict.regressedKeys.slice(0, MAX_LOGGED_REGRESSED_KEYS),
      regressedKeyCount: exhaustedGateVerdict.regressedKeys.length,
      baselineKeySize: exhaustedGateVerdict.baselineKeySize,
      keyless: exhaustedGateVerdict.keyless,
      memoExcludedKeyCount: exhaustedGateVerdict.memoExcludedKeys.length,
      // Same gap as the sibling log above — triage owns the main gate path only (#1383).
      flakeTriageRan: false,
    });
  }

  return restoreToSnapshot(args, _deps, restoreRef, phaseOutputsSnapshot, phaseCostsSnapshot, logger);
}

async function restoreToSnapshot(
  args: NonBlockingFixArgs,
  _deps: NonBlockingFixDeps,
  restoreRef: string,
  phaseOutputsSnapshot: Record<string, unknown>,
  phaseCostsSnapshot: Record<string, number>,
  logger: ReturnType<typeof getSafeLogger>,
): Promise<NonBlockingFixResult> {
  await _deps.rollbackToRef(args.workdir, restoreRef);
  // In-place restore required: ExecutionPlan.run holds a direct reference to phaseOutputs
  // and phaseCosts; returning new objects would leave the caller with stale gate/verifier
  // results and inflated costs from the failed best-effort pass. Intentional exception to
  // the immutability rule. Cost is restored alongside outputs so the result's per-phase
  // breakdown stays symmetric with its outputs after a discarded pass.
  for (const key of Object.keys(args.phaseOutputs)) delete args.phaseOutputs[key];
  Object.assign(args.phaseOutputs, phaseOutputsSnapshot);
  for (const key of Object.keys(args.phaseCosts)) delete args.phaseCosts[key];
  Object.assign(args.phaseCosts, phaseCostsSnapshot);
  logger?.info("non-blocking-fix", "best-effort fix exhausted — restored to adversarial-passed", {
    storyId: args.storyId,
  });

  return { ran: true, kept: false, restored: true };
}
