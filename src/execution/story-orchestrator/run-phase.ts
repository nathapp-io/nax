import type { Finding, FindingSeverity, FixStrategy, Iteration } from "@/findings";
import { runFixCycle } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { AdversarialReviewInput, CallContext, SemanticReviewInput } from "@/operations";
import { callOp } from "@/operations";
import { pipelineEventBus } from "@/pipeline";
import type { StoryPhaseCompletedEvent } from "@/pipeline/event-bus";
import {
  getAdversarialIterations,
  isBlockingSeverity,
  prepareAdversarialReviewInput,
  prepareSemanticReviewInput,
  recordAdversarialIteration,
} from "@/review";
import { errorMessage } from "@/utils/errors";
import { _gitDeps, captureGitRef } from "@/utils/git";
import { captureTreeState as realCaptureTreeState } from "../checkpoint/resume-hydrate";
import { buildResumePlan as realBuildResumePlan } from "../checkpoint/resume-plan";
import type { ResumePlan } from "../checkpoint/resume-plan";
import type { StoryCheckpoint, TreeState } from "../checkpoint/types";
import { runNonBlockingFix } from "../non-blocking-fix";
import { buildPhaseOutcomeLogData, logDeterministicPhaseOutcome } from "../story-orchestrator-logging";
import { productionTriageSeam } from "./flake-triage-seam";
import { emitReviewDecision, logUnifiedReviewPhaseResult, logUnifiedReviewPhaseStart } from "./review-decision";
import type { AnySlot } from "./types";
import { TDD_OP_NAMES } from "./types";

export const _storyOrchestratorDeps = {
  callOp,
  runFixCycle,
  captureGitRef,
  prepareSemanticReviewInput,
  prepareAdversarialReviewInput,
  runNonBlockingFix,
  /**
   * US-003 flake-triage seam — bound to the real `triageFlakyFindings`
   * (probe + baseline diff + run-scoped quarantine memo). Overridable in
   * tests via `_storyOrchestratorDeps.triage`.
   */
  triage: productionTriageSeam,
  /**
   * US-003 resume-integration deps. Defaults are wired to real production
   * implementations so the resume system works out of the box. Tests
   * override these to capture dispatch without hitting disk or git.
   */
  recordGreen: async (_storyId: string, _phase: string, _tree: TreeState): Promise<void> => {
    // Stub — requires filePath + runId from the CLI layer to instantiate
    // CheckpointWriter. The CLI/runner layer overrides this with a real
    // writer when a featureDir is available.
  },
  buildResumePlan: async (checkpoint: StoryCheckpoint | null, current: TreeState): Promise<ResumePlan> =>
    realBuildResumePlan(checkpoint, current),
  captureTreeState: async (workdir: string): Promise<TreeState> => {
    const spawnWrapper = (cmd: string[], opts: unknown): unknown =>
      _gitDeps.spawn(cmd, opts as Parameters<typeof _gitDeps.spawn>[1]);
    return realCaptureTreeState(workdir, { _deps: { spawn: spawnWrapper } });
  },
  loadCheckpoints: async (_featureDir: string): Promise<Map<string, StoryCheckpoint>> => new Map(),
};

/**
 * @internal
 * Refresh stat/diff/excludePatterns/effectiveRef on a semantic-review or
 * adversarial-review input just before dispatch. Plan-build captures these
 * fields too early (before test-writer/implementer have produced a real diff)
 * so they go stale by the time the review actually runs.
 *
 * Behavior:
 *   - Non-review phases pass through unchanged.
 *   - Inputs without `_refresh` pass through unchanged (backward compat).
 *   - The `_refresh` field is stripped from the returned input so the op
 *     handler never sees the plan-time payload.
 *   - If the prepare call throws (e.g. mid-write worktree, git errors), the
 *     stale input is returned with a warn log — preserves the prior dispatch
 *     rather than aborting the whole story.
 *
 * Exported for unit testing; not for external callers — use `runPhase`.
 */
export async function refreshReviewInputForDispatch(opName: string, input: unknown): Promise<unknown> {
  if (opName !== "semantic-review" && opName !== "adversarial-review") return input;
  const i = input as { _refresh?: SemanticReviewInput["_refresh"]; workdir?: string };
  const { _refresh } = i;
  if (!_refresh || !i.workdir) return input;
  try {
    if (opName === "semantic-review") {
      const { _refresh: _, ...semInput } = input as SemanticReviewInput;
      const fresh = await _storyOrchestratorDeps.prepareSemanticReviewInput({
        workdir: semInput.workdir,
        projectDir: _refresh.projectDir,
        storyId: _refresh.storyId,
        storyGitRef: _refresh.storyGitRef,
        config: _refresh.config,
        naxIgnoreIndex: _refresh.naxIgnoreIndex,
        resolvedTestPatterns: _refresh.resolvedTestPatterns,
        semanticConfig: semInput.semanticConfig,
      });
      return {
        ...semInput,
        stat: fresh.stat,
        diff: fresh.diff,
        excludePatterns: fresh.excludePatterns,
        storyGitRef: fresh.effectiveRef ?? semInput.storyGitRef,
        // Mirrors the adversarial branch below — the op needs the patterns to keep
        // findings about test files in the test lane (#1368).
        resolvedTestPatterns: _refresh.resolvedTestPatterns,
      };
    }
    const { _refresh: __, ...advInput } = input as AdversarialReviewInput;
    const fresh = await _storyOrchestratorDeps.prepareAdversarialReviewInput({
      workdir: advInput.workdir,
      projectDir: _refresh.projectDir,
      storyId: _refresh.storyId,
      storyGitRef: _refresh.storyGitRef,
      config: _refresh.config,
      naxIgnoreIndex: _refresh.naxIgnoreIndex,
      resolvedTestPatterns: _refresh.resolvedTestPatterns,
      adversarialConfig: advInput.adversarialConfig,
    });
    return {
      ...advInput,
      stat: fresh.stat,
      diff: fresh.diff,
      testInventory: fresh.testInventory,
      excludePatterns: fresh.excludePatterns,
      testGlobs: fresh.testGlobs,
      refExcludePatterns: fresh.refExcludePatterns,
      storyGitRef: fresh.effectiveRef ?? advInput.storyGitRef,
      resolvedTestPatterns: _refresh.resolvedTestPatterns,
    };
  } catch (err) {
    getSafeLogger()?.warn("story-orchestrator", "review input refresh failed — dispatching with stale input", {
      storyId: _refresh.storyId,
      phase: opName,
      error: errorMessage(err),
    });
    // Strip _refresh even on the fallback so the op handler never sees it.
    const { _refresh: _stripped, ...fallback } = input as Record<string, unknown> & {
      _refresh?: unknown;
    };
    return fallback;
  }
}

export async function runPhase(
  ctx: CallContext,
  slot: AnySlot,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
  isThreeSession = false,
  progress?: { index: number; total: number },
): Promise<unknown> {
  const logger = getSafeLogger();
  const opName = slot.op.name;
  // Phase progress counter (e.g. 5/8) for headless-log orientation in long runs.
  // Only the canonical run() loop supplies it; rectification/fix-cycle callers omit it.
  const progressData = progress ? { phaseIndex: progress.index, totalPhases: progress.total } : {};
  // Isolation enforcement + TDD-stage logs only apply when the orchestrator is
  // executing a three-session-tdd strategy. The single-session ("no-test") path
  // reuses implementerOp but has no boundary semantics to enforce, so capturing
  // beforeRef and emitting "Session: implementer" / "Isolation maintained" there
  // would be misleading.
  const isTddPhase = isThreeSession && TDD_OP_NAMES.has(opName);

  // Pre-phase: capture git ref for TDD phases; emit phase-begin log.
  const beforeRef = isTddPhase ? await _storyOrchestratorDeps.captureGitRef(ctx.packageDir) : undefined;
  let dispatchInput = isTddPhase && beforeRef ? { ...(slot.input as Record<string, unknown>), beforeRef } : slot.input;
  // Refresh stat/diff/etc for review phases — plan-build's snapshot is stale.
  dispatchInput = await refreshReviewInputForDispatch(opName, dispatchInput);
  if (opName === "adversarial-review" && ctx.storyId) {
    dispatchInput = {
      ...(dispatchInput as Record<string, unknown>),
      priorAdversarialIterations: getAdversarialIterations(ctx.runtime.adversarialIterations, ctx.storyId),
    };
  }

  if (isTddPhase) {
    logger?.info("tdd", `-> Session: ${opName}`, { storyId: ctx.storyId, role: opName, ...progressData });
  } else if (isThreeSession && opName === "full-suite-gate") {
    logger?.info("tdd", "-> Running full test suite gate (before Verifier)", {
      storyId: ctx.storyId,
      ...progressData,
    });
  }
  logUnifiedReviewPhaseStart(ctx.storyId, opName);

  // Emit TUI step event so the live activity panel can show the current orchestrator step.
  if (ctx.storyId) {
    pipelineEventBus.emit({ type: "story:step", storyId: ctx.storyId, step: opName });
  }

  const phaseStartedAt = Date.now();
  const scope = ctx.runtime.costAggregator.openScope();
  let outcome: "passed" | "failed" | "skipped" | "error" = "passed";
  try {
    const output = await _storyOrchestratorDeps.callOp({ ...ctx, scopeId: scope.scopeId }, slot.op, dispatchInput);
    phaseOutputs[opName] = output;
    emitReviewDecision(ctx, opName, output);
    if (opName === "adversarial-review" && ctx.storyId) {
      const advOut = output as { normalizedFindings?: Finding[]; advisoryFindings?: Finding[] };
      recordAdversarialIteration(ctx.runtime.adversarialIterations, ctx.storyId, [
        ...(advOut.normalizedFindings ?? []),
        ...(advOut.advisoryFindings ?? []),
      ]);
    }
    logUnifiedReviewPhaseResult(ctx.storyId, opName, output);
    logDeterministicPhaseOutcome(
      ctx.storyId,
      opName,
      output,
      Date.now() - phaseStartedAt,
      isTddPhase,
      slot.op.stage,
      progressData,
    );
    outcome = derivePhaseOutcome(output);

    // Post-phase logs (TDD phases only).
    if (isTddPhase) {
      const durationMs = Date.now() - phaseStartedAt;
      logger?.info("tdd", `Session complete: ${opName}`, {
        storyId: ctx.storyId,
        role: opName,
        durationMs,
      });

      const filesChanged = (output as { filesChanged?: readonly string[] })?.filesChanged ?? [];
      if (opName === "test-writer" && filesChanged.length > 0) {
        logger?.info("tdd", "Created test files", {
          storyId: ctx.storyId,
          testFilesCount: filesChanged.length,
          testFiles: [...filesChanged],
        });
      }

      // Isolation is ADVISORY here, by design. The mechanical check
      // (verifyTestWriterIsolation / verifyImplementerIsolation) detects which files
      // changed but cannot judge whether a change is LEGITIMATE — only the verifier can
      // (e.g. a stub in src/ may be required). So a mechanical violation is logged, not
      // enforced: it never flips phase success and never produces the `isolation-violation`
      // FailureCategory. Legitimacy is owned by the verifier, which emits `verifier-rejected`
      // for illegitimate test modifications (see tdd/verdict.ts). The `isolation-violation`
      // category's consumer machinery (escalate→retryAsLite, pause, rollback) stays wired for
      // a verifier- or plugin-driven producer; do not wire this mechanical check to it.
      // (Audit #8 — resolved as documented, not a missing producer.)
      const isolation = (output as { isolation?: { passed: boolean; violations: string[] } })?.isolation;
      if (isolation) {
        if (isolation.passed) {
          logger?.info("tdd", "Isolation maintained", { storyId: ctx.storyId, role: opName });
        } else {
          logger?.error("tdd", "Isolation violated (advisory — verifier judges legitimacy)", {
            storyId: ctx.storyId,
            role: opName,
            violations: isolation.violations,
          });
        }
      }
    }

    return output;
  } catch (err) {
    outcome = "error";
    throw err;
  } finally {
    const snapshot = scope.snapshot();
    phaseCosts[opName] = (phaseCosts[opName] ?? 0) + snapshot.totalCostUsd;
    scope.close();
    if (ctx.storyId) {
      const phaseDetails = buildPhaseDetails(opName, phaseOutputs[opName], isThreeSession);
      const event: StoryPhaseCompletedEvent = {
        type: "story:phase:completed",
        storyId: ctx.storyId,
        phase: opName,
        outcome,
        durationMs: Date.now() - phaseStartedAt,
        costUsd: snapshot.totalCostUsd,
        ...(ctx.phaseTelemetry
          ? {
              tier: ctx.phaseTelemetry.tier,
              testStrategy: ctx.phaseTelemetry.testStrategy,
              sessionModel: ctx.phaseTelemetry.sessionModel,
            }
          : {}),
        ...(phaseDetails !== undefined ? { details: phaseDetails } : {}),
      };
      pipelineEventBus.emit(event);
    }
  }
}

const ALL_FINDING_SEVERITIES: readonly FindingSeverity[] = [
  "critical",
  "error",
  "warning",
  "info",
  "low",
  "unverifiable",
];

function buildPhaseDetails(
  opName: string,
  output: unknown,
  isThreeSession: boolean,
): Record<string, unknown> | undefined {
  if (opName === "adversarial-review") {
    const adv = output as { normalizedFindings?: Array<{ severity: string }>; blockingThreshold?: string } | undefined;
    const findings = adv?.normalizedFindings ?? [];
    const threshold = (adv?.blockingThreshold ?? "error") as "error" | "warning" | "info";
    const bySeverity = Object.fromEntries(
      ALL_FINDING_SEVERITIES.map((sev) => [sev, findings.filter((f) => f.severity === sev).length]),
    ) as Record<FindingSeverity, number>;
    const blockingCount = findings.filter((f) => isBlockingSeverity(f.severity, threshold)).length;
    const advisoryCount = findings.length - blockingCount;
    return { kind: "review", reviewer: "adversarial", bySeverity, blockingCount, advisoryCount };
  }

  if (opName === "implementer" && isThreeSession) {
    const impl = output as { isolation?: { passed: boolean } } | undefined;
    return { kind: "authoring", role: "implementer", isolationPassed: impl?.isolation?.passed };
  }

  if (opName === "full-suite-gate") {
    return { kind: "gate", gate: "full-suite" };
  }

  return undefined;
}

/**
 * Derive the phase-completion outcome from an operation's output, reusing
 * `buildPhaseOutcomeLogData` so the per-phase log and the bus event stay in
 * lockstep. Non-object outputs are treated as `passed` (no `details`).
 */
function derivePhaseOutcome(output: unknown): "passed" | "failed" | "skipped" {
  const built = buildPhaseOutcomeLogData(undefined, "", output, 0);
  if (!built) return "passed";
  if (built.success) return "passed";
  if (built.data.status === "skipped") return "skipped";
  return "failed";
}

/**
 * Wrap each strategy with a bailWhen predicate that fires only after
 * `consecutiveIncreases` *trailing* iterations have each regressed the finding
 * count (findingsAfter > findingsBefore). A threshold of 1 reproduces the legacy
 * "bail on the first regressing iteration" behaviour; higher values tolerate a
 * transient regression — e.g. a tightened test surfacing more verifier failures
 * before the implementer fixes the source. Preserves user-supplied bailWhen if
 * present (user predicate wins). Returns the unchanged strategies when off.
 *
 * @internal Exported for unit testing; not for external callers.
 */
export function withIncreasingFailuresBail(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
  enabled: boolean,
  consecutiveIncreases: number,
): FixStrategy<Finding, unknown, unknown, unknown>[] {
  if (!enabled) return strategies;
  const threshold = Math.max(1, consecutiveIncreases);
  return strategies.map((strategy) => ({
    ...strategy,
    bailWhen: (iterations: Iteration<Finding>[]): string | null => {
      const userReason = strategy.bailWhen?.(iterations) ?? null;
      if (userReason !== null) return userReason;
      if (iterations.length < threshold) return null;
      const trailing = iterations.slice(-threshold);
      const allRegressed = trailing.every((it) => it.findingsAfter.length > it.findingsBefore.length);
      if (allRegressed) {
        const first = trailing[0];
        const last = trailing[trailing.length - 1];
        return `failure count increased for ${threshold} consecutive iteration(s): ${first.findingsBefore.length} -> ${last.findingsAfter.length}`;
      }
      return null;
    },
  }));
}
