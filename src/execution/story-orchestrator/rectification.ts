import type { Finding, FixCycle, FixCycleContext } from "@/findings";
import { appendStoryFixIterations, getStoryFixState, mergeStoryFixDeclines, storyFixKey } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { CallContext, Operation, RunOperation } from "@/operations";
import { countOscillationOutcomes, recordOscillations } from "../oscillation-store";
import { triageNbfGate } from "./nbf-flake-triage";
import { withNoProgressBail } from "./no-progress-bail";
import { extractPhaseFindings, orderGateLast, phasesToRevalidate } from "./phase-eval";
import { isQuarantinedFlake, phaseExplicitlyPassed, phasePassed, selectRegressedGateFindings } from "./phase-eval";
import { deriveRepoScopedFixes } from "./repo-scoped-fix-record";
import { _storyOrchestratorDeps, runPhase, withIncreasingFailuresBail } from "./run-phase";
import type { AnySlot, InternalBuildState, InternalPhase, RectificationOverrides, RectificationResult } from "./types";
import { EXHAUSTED_EXIT_REASONS } from "./types";

/** Inputs to `shouldSkipPhaseForRectification`. Options object — the convention caps positional params at three. */
export interface SkipPhaseForRectificationInput {
  phase: InternalPhase;
  state: InternalBuildState;
  phaseOutputs: Record<string, unknown>;
  /**
   * True on the ADR-024 nbf revalidation sweep, where the carve-out must NOT apply (#1401).
   *
   * Two reasons. First, correctness: `phasesToRevalidate` orders the gate BEFORE the
   * verifier, so at this point `phaseOutputs[verifier]` still holds the verifier's
   * PRE-rectification pass. Reading it would exempt the gate on stale evidence — the
   * verifier has not yet judged the tree the nbf pass just edited.
   *
   * Second, the policy has nothing to protect here. The carve-out exists so a story is
   * not rolled back over regressions it did not cause; nbf never fails a story, it only
   * chooses keep-vs-discard of its own edits, and `runNonBlockingFix` reads the same gate
   * output RAW (`describeGateRegression`) to make that choice. Hiding the failure from the
   * cycle therefore changed nothing about the outcome — it only forfeited the
   * `regressionAttempts` repair budget and let the sweep spend a verifier session on a
   * tree that was already condemned.
   */
  nbfPath?: boolean;
}

/**
 * Verifier-as-SSOT: when the verifier explicitly passed, full-suite-gate
 * failures represent unrelated regressions that this story did not cause.
 * Excluded from rectification (mirrors the carve-out in ExecutionPlan.run
 * success aggregation and post-run.ts:deriveFailureCategory).
 */
export function shouldSkipPhaseForRectification(input: SkipPhaseForRectificationInput): boolean {
  const { phase, state, phaseOutputs, nbfPath } = input;
  if (phase.kind !== "full-suite-gate") return false;
  if (nbfPath) return false;
  const verifierName = state.verifier?.slot.op.name;
  if (!verifierName) return false;
  return phaseExplicitlyPassed(phaseOutputs[verifierName]);
}

export function gatherRectificationFindings(
  phaseOutputs: Record<string, unknown>,
  phases: readonly InternalPhase[],
  state: InternalBuildState,
): Finding[] {
  const findings: Finding[] = [];
  for (const phase of phases) {
    // Seed-gathering runs only on the main path (the nbf path seeds from
    // `overrides.initialFindings`), so the carve-out always applies here.
    if (shouldSkipPhaseForRectification({ phase, state, phaseOutputs })) continue;
    for (const f of extractPhaseFindings(phaseOutputs[phase.slot.op.name])) {
      // Quarantined flakes (category === "flaky-test") are NOT actionable — the
      // story didn't cause them. Excluding them here keeps them out of the fix
      // cycle (AC3) so the cycle only drives `failed-test` findings to a fix.
      if (f.category === "flaky-test") continue;
      findings.push(f);
    }
  }
  return findings;
}

/** Triage result tuple shape — produced by `_storyOrchestratorDeps.triage`. */
export type { TriageResult } from "./flake-triage-seam";

/**
 * Run flake triage on the gate's `failed-test` findings BEFORE
 * `gatherRectificationFindings` reads them. Mutates `phaseOutputs[gateName]`
 * so:
 *   - the gate's findings list is replaced with the triaged set (which may
 *     contain `flaky-test` and `failed-test` entries)
 *   - when no `failed-test` entries remain, `success` / `passed` are flipped
 *     to `true` so the gate no longer blocks the story
 *
 * Callers (ExecutionPlan.run) gate this call with `overrides.skipGateTriage`
 * so the post-rectification resume's second pass does NOT re-triage already
 * triaged findings.
 *
 * Async: awaits the triage seam (the real `triageFlakyFindings` probes
 * subprocesses and is async). The seam is invoked inside a try/catch so a
 * crashing probe / config-invariant assertion cannot abort the story —
 * triage failure degrades to "no quarantine" and the gate findings flow
 * through to the fix cycle unchanged.
 *
 * Exported for unit testing; the triage dependency is read from
 * `_storyOrchestratorDeps.triage`, which is wired to `productionTriageSeam`
 * in production (see `run-phase.ts`).
 */
export async function triageGateFindings(
  phaseOutputs: Record<string, unknown>,
  gateName: string | undefined,
  ctx: CallContext,
): Promise<{ triaged: boolean; quarantinedKeys: readonly string[]; skipped: boolean }> {
  if (!gateName) return { triaged: false, quarantinedKeys: [], skipped: true };
  const triage = _storyOrchestratorDeps.triage;
  if (typeof triage !== "function") return { triaged: false, quarantinedKeys: [], skipped: true };

  const output = phaseOutputs[gateName];
  if (output === null || output === undefined || typeof output !== "object") {
    return { triaged: false, quarantinedKeys: [], skipped: true };
  }
  const record = output as Record<string, unknown>;
  // Triage runs on the gate's failed-test findings only (the seam contract).
  // extractPhaseFindings already filters to source-tagged, success=false
  // findings — i.e. the same set downstream consumers would see.
  const findings = extractPhaseFindings(output);
  if (findings.length === 0) {
    return { triaged: false, quarantinedKeys: [], skipped: true };
  }
  const rawOutput = typeof record.rawOutput === "string" ? record.rawOutput : "";

  // Awaited and guarded: triage failure (probe crash, misconfigured diff,
  // memo invariant) MUST NOT abort the story. On failure we keep findings
  // blocking (degrade to "no quarantine") and surface a warn so operators
  // have visibility (F5 — no silent triage-skip).
  let triagedFindings: Finding[];
  let quarantinedKeys: readonly string[];
  try {
    // scope: the blocking cycle is the only one that can dispatch
    // repo-scoped-test-fix, so its skips are the ones #1657 §3 is deciding on.
    const [triaged, report] = await triage(findings, { ctx, rawOutput, scope: "blocking-gate" });
    triagedFindings = triaged;
    quarantinedKeys = report.quarantinedKeys;
  } catch (err) {
    getSafeLogger()?.warn("story-orchestrator", "Flake triage threw — keeping findings blocking (no quarantine)", {
      storyId: ctx.storyId,
      gateName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { triaged: false, quarantinedKeys: [], skipped: true };
  }

  // Replace the gate's findings list with the triaged set. When no
  // test-runner finding survives that the seam has NOT explicitly
  // quarantined (relabeled to `flaky-test`), flip success/passed so the
  // story can pass with quarantine warnings rather than over the gate's
  // original failure. Un-categorized test-runner findings are still
  // blocking — the seam is the authority on triage, and silence is not
  // consent (an un-categorized finding is not the same as a
  // "no real failures" verdict).
  const allTestRunnersQuarantined = triagedFindings.every(
    (f) => f.source !== "test-runner" || f.category === "flaky-test",
  );
  const nextRecord: Record<string, unknown> = { ...record, findings: triagedFindings };
  if (allTestRunnersQuarantined) {
    nextRecord.success = true;
    nextRecord.passed = true;
  }
  phaseOutputs[gateName] = nextRecord;

  // Emit one warn per quarantined test, keyed by `${file}::${testName}`,
  // tagged with storyId (AC6).
  if (quarantinedKeys.length > 0) {
    const logger = getSafeLogger();
    for (const key of quarantinedKeys) {
      logger?.warn("story-orchestrator", `Flake quarantined: ${key}`, {
        storyId: ctx.storyId,
        key,
        previousFailureCount: findings.length,
      });
    }
  }
  return { triaged: true, quarantinedKeys, skipped: false };
}

/**
 * Collect all phases that participate in the rectification validation sweep.
 * Verifier is included here because phasesToRevalidate() allows it to be
 * re-dispatched when a code-editing strategy (full-suite-rectify only) ran.
 * Without this, a stale verifier failure from before rectification would remain
 * in phaseOutputs and mark the story failed even after the gate goes green.
 * shouldSkipPhaseForRectification() gates the gate phase when verifier already
 * explicitly passed (unrelated-regression case).
 */
export function collectRectificationPhases(state: InternalBuildState): InternalPhase[] {
  return [
    state.fullSuiteGate,
    state.verifier,
    state.verifyScoped,
    state.lintCheck,
    state.typecheckCheck,
    state.semanticReview,
    state.adversarialReview,
  ].filter((phase): phase is InternalPhase => phase !== undefined);
}

function isQuarantinedOnlyGateFailure(
  phase: InternalPhase,
  rawFindings: readonly Finding[],
  blockingFindings: readonly Finding[],
): boolean {
  return phase.kind === "full-suite-gate" && rawFindings.length > 0 && blockingFindings.length === 0;
}

/**
 * @internal
 * Run the rectification loop and return a structured result describing the exit.
 * Returns `{ liteScopeIncomplete: true }` when the cycle exited with
 * "validate-short-circuit" and no remaining findings — the resume block must
 * still dispatch phases that were absent during the short-circuited validate.
 *
 * Exported for unit testing; not for external callers — use `ExecutionPlan.run`.
 */
export async function runRectification(
  ctx: CallContext,
  state: InternalBuildState,
  phaseCosts: Record<string, number>,
  phaseOutputs: Record<string, unknown>,
  overrides?: RectificationOverrides,
): Promise<RectificationResult> {
  const rectification = state.rectification;
  const baseValidationPhases = collectRectificationPhases(state);
  const validationPhases = overrides?.excludePhaseKinds
    ? baseValidationPhases.filter((p) => !overrides.excludePhaseKinds?.includes(p.kind))
    : baseValidationPhases;
  if (!rectification || validationPhases.length === 0) {
    return {};
  }
  if (ctx.runtime.signal?.aborted) {
    return {};
  }

  let initialFindings: Finding[];
  // The ADR-024 nbf discriminator, assigned by the branch below rather than re-tested
  // from `overrides` — the two must never be able to disagree about which path is
  // running. Seeded findings are what distinguishes the best-effort pass from the main
  // rectification loop, so this is also the SSOT for the behaviours that differ: no
  // flake triage (#1383), and no verifier-SSOT carve-out in the validate sweep (#1401).
  let nbfPath = false;
  if (overrides?.initialFindings) {
    nbfPath = true;
    // ADR-024 nbf path — triage is a separate concern owned by the main gate path.
    //
    // Seed findings are advisory-review findings, so they still bypass gate triage.
    // #1404 triages only newly failing gate findings later, inside validate(), using
    // the optional transaction-local `nbfFlakeTriage` state.
    initialFindings = [...overrides.initialFindings];
  } else {
    // US-003 — Flake triage runs on the gate's failed-test findings BEFORE
    // gatherRectificationFindings reads them, but only when this is the
    // orchestrator's first rectification pass on this gate's findings.
    // ExecutionPlan.run gates the call to `triageGateFindings` so the second
    // (post-resume) pass does NOT re-triage already-triaged findings.
    const gateName = state.fullSuiteGate?.slot.op.name;
    if (overrides?.skipGateTriage !== true) {
      const triageReport = await triageGateFindings(phaseOutputs, gateName, ctx);
      // F5 — surface whether triage actually ran or was skipped (no gate
      // output, no findings, seam threw). Operators need this signal: silent
      // triage-skip would let pre-existing flakes slip into the fix cycle
      // without anyone noticing.
      if (triageReport.skipped && gateName !== undefined) {
        getSafeLogger()?.debug("story-orchestrator", "Gate triage skipped — passthrough to fix cycle", {
          storyId: ctx.storyId,
          gateName,
          triaged: triageReport.triaged,
        });
      }
    }
    initialFindings = gatherRectificationFindings(phaseOutputs, validationPhases, state);
  }
  if (initialFindings.length === 0) {
    return {};
  }
  if (initialFindings.some((finding) => finding.category === "incorrect-test-assertion")) {
    getSafeLogger()?.warn("story-orchestrator", "Incorrect test diagnosis requires human review", {
      storyId: ctx.storyId,
      findingCount: initialFindings.length,
    });
    return { terminalReviewRequired: true, unfixedFindings: initialFindings };
  }
  if (!ctx.storyId) {
    // runFixCycle requires storyId for parallel-log correlation.
    return {};
  }

  // Story-scoped fix budget (US-003): when enabled, seed priorIterations and
  // the decline-ledger backing from the run-scoped store so repeated main and
  // resume passes for one (storyId, tier) pair consume a common budget.
  //
  // Excluded from the nbf (non-blocking-fix) path: it retains its own
  // independent per-cycle budget (out-of-scope item).
  const storyFixBudgetEnabled =
    !nbfPath && ctx.runtime.configLoader.current().execution?.rectification?.storyScopedFixBudget === true;
  const store = ctx.runtime.storyFixHistory;
  // Keyed on the full escalation rung (tier AND agent), not the tier alone: a
  // cross-agent ladder can escalate to a rung that reuses a tier name, and a
  // tier-only key hands that rung the previous agent's exhausted budget (#1530).
  const fixKey = storyFixBudgetEnabled ? storyFixKey(ctx.storyId, ctx.phaseTelemetry?.tier, ctx.agentName) : undefined;
  const fixState = fixKey !== undefined && store ? getStoryFixState(store, fixKey) : undefined;
  // Captured before the cycle runs so the exit-reason remap below (US-003 AC6)
  // reflects the budget state the cycle actually started with, independent of
  // whether appendStoryFixIterations happens to replace or mutate fixState.iterations.
  const priorIterationCount = fixState?.iterations.length ?? 0;
  // Cycle-local snapshot: the ledger writes into this map live during the cycle, but
  // it is only merged back into the store after runFixCycle returns (below) — so a
  // mid-cycle throw discards both the decline ledger and the iteration history
  // together, instead of leaving findings permanently retired with zero recorded attempts.
  const declineSnapshot = fixState
    ? new Map([...fixState.declines].map(([name, keys]) => [name, new Set(keys)]))
    : undefined;

  // Separate map for fix-op outputs so intermediate implementer results don't contaminate
  // the final phaseOutputs success aggregation. The validate callback continues to write
  // gate/verifier re-run results into phaseOutputs so they ARE reflected in the final success.
  const fixOpPhaseOutputs: Record<string, unknown> = {};
  const wrappedCallOp = async <I, O, C>(cycleCtx: FixCycleContext, op: Operation<I, O, C>, input: I): Promise<O> => {
    // runFixCycle dispatches fixOps, which are Operation<I,O,C> (run or complete). The
    // builder's runPhase wrapper only needs op.name + dispatch, so widening the cast is safe.
    const slot: AnySlot = { op: op as unknown as RunOperation<unknown, unknown, unknown>, input };
    return (await runPhase(cycleCtx, slot, phaseCosts, fixOpPhaseOutputs)) as O;
  };

  const cycle: FixCycle<Finding> = {
    findings: [...initialFindings],
    iterations: [],
    priorIterations: fixState?.iterations,
    strategies: withNoProgressBail(
      withIncreasingFailuresBail(
        (overrides?.strategies ?? rectification.strategies) as import("@/findings").FixStrategy<
          Finding,
          unknown,
          unknown,
          unknown
        >[],
        rectification.abortOnIncreasingFailures,
        rectification.consecutiveIncreasesToBail ?? 1,
      ),
      rectification.abortOnNoProgress ?? true,
      rectification.consecutiveNoProgressToBail ?? 3,
    ),
    config: { maxAttemptsTotal: overrides?.maxAttempts ?? rectification.maxAttempts, validatorRetries: 1 },
    validate: async (_validateCtx, opts) => {
      if (ctx.runtime.signal?.aborted) return { findings: [], shortCircuited: false };
      // opts is required by the FixCycle.validate contract but guard defensively for
      // plugin-supplied cycles that may call validate without opts (legacy shape).
      const lite = (opts?.mode ?? "full") === "lite";
      const selected = phasesToRevalidate(opts?.strategiesRun, validationPhases);
      const extra = overrides?.extraRevalidationKinds
        ? validationPhases.filter(
            (p) => overrides.extraRevalidationKinds?.includes(p.kind) && !selected.some((s) => s.kind === p.kind),
          )
        : [];
      const selectedWithExtra = [...selected, ...extra];
      // Terminal lite-validate: the full-suite gate is the most expensive phase
      // AND, for gate-seeded cycles (full-suite-rectify), the actual arbiter of
      // "resolved". It used to be SKIPPED entirely in lite mode, which let the
      // cycle declare "resolved" off the cheaper phases alone (semantic last)
      // without ever re-running the gate that had just received a fix — a
      // dishonest exit. Instead run it LAST: a failing cheaper phase
      // short-circuits before the gate is ever dispatched (preserving the cost
      // saving that motivated lite mode), and when everything cheaper is green
      // the gate is re-run to validate the fix.
      //
      // Caveat — on the MAIN path the verifier-SSOT carve-out still applies: when a
      // verifier ran and passed, `shouldSkipPhaseForRectification` discards the gate's
      // finding (unrelated-regression policy, lines ~430), so in that case the gate is
      // dispatched (validating the just-applied fix per Q1) but does NOT block
      // "resolved". The gate is the decisive arbiter only when no passing
      // verifier overrides it (single-session, or a failed/absent verifier).
      // Session-agnostic — also covers a single-session per-story
      // full-suite-gate; verify-scoped was never skipped and is unaffected.
      //
      // On the nbf path the carve-out is OFF (#1401): the verifier output in scope is
      // pre-rectification, and nbf discards its own tree on gate red regardless — see
      // `SkipPhaseForRectificationInput.nbfPath`.
      const phases = lite ? orderGateLast(selectedWithExtra) : selectedWithExtra;
      getSafeLogger()?.debug("story-orchestrator", "rectification validate scope", {
        storyId: ctx.storyId,
        mode: opts?.mode ?? "full",
        strategiesRun: opts?.strategiesRun,
        phasesSelected: phases.map((p) => p.kind),
      });
      const findings: Finding[] = [];
      let shortCircuited = false;
      for (const phase of phases) {
        await runPhase(ctx, phase.slot, phaseCosts, phaseOutputs);
        if (shouldSkipPhaseForRectification({ phase, state, phaseOutputs, nbfPath })) {
          // Carve-out fired: the verifier explicitly passed, so this story is not failed
          // by the gate here. It still must not swallow a regression rectification just
          // introduced — that set is precisely what the staleness guard in
          // `ExecutionPlan.run` will fail the story on, so hand it to the cycle instead of
          // discarding it and failing later with no repair attempted (#1452).
          //
          // Findings only: the short-circuit below stays skipped, preserving the carve-out's
          // other half — downstream phases still run, since a verifier-passed story should
          // not have its reviews withheld over a gate the verifier already judged.
          const carvedOutFindings = selectRegressedGateFindings(
            extractPhaseFindings(phaseOutputs[phase.slot.op.name]),
            overrides?.gateBaselineKeys ?? new Set<string>(),
            ctx.runtime.quarantineMemo,
          );
          if (carvedOutFindings.length > 0) {
            getSafeLogger()?.warn("story-orchestrator", "Gate regressed under the verifier-SSOT carve-out", {
              storyId: ctx.storyId,
              phase: phase.slot.op.name,
              regressedCount: carvedOutFindings.length,
            });
          }
          findings.push(...carvedOutFindings);
          continue;
        }
        const output = phaseOutputs[phase.slot.op.name];
        const nbfFlakeTriage = overrides?.nbfFlakeTriage;
        if (nbfPath && phase.kind === "full-suite-gate" && nbfFlakeTriage) {
          await triageNbfGate({
            output,
            gateName: phase.slot.op.name,
            ctx,
            transaction: nbfFlakeTriage,
            triage: _storyOrchestratorDeps.triage,
          });
        }
        // #1383 parity. `describeGateRegression` — the predicate that actually decides
        // keep-vs-discard for this pass — excludes failures the run already quarantined as
        // flakes. Until #1401 the carve-out hid the whole gate output from the nbf sweep, so
        // the cycle never had to agree with it; now it does. Without this filter a known
        // flake firing inside the revalidation window would buy an agent session to "fix" it
        // (via `full-suite-rectify`, which edits TEST code) and then discard a pass the
        // keep-decision would have kept — silently walking back #1383.
        //
        // nbf-scoped: the main path reaches the same place differently (triage runs there and
        // relabels quarantined failures to `flaky-test`, which `gatherRectificationFindings`
        // already drops), so widening this would be an unrelated behaviour change.
        const phaseFindings = extractPhaseFindings(output);
        const blockingFindings = nbfPath
          ? phaseFindings.filter(
              (finding) => !isQuarantinedFlake(finding, nbfFlakeTriage?.memo ?? ctx.runtime.quarantineMemo),
            )
          : phaseFindings;
        findings.push(...blockingFindings);
        // Mirror the main loop's halt-on-failure contract (spec §2C, PR #1127):
        // verifier and reviews must never judge broken-gate code, even inside the
        // rectification revalidation sweep. Findings collected so far feed the next
        // fix iteration; downstream phases are skipped to avoid stale-verdict pollution.
        const quarantinedOnly = nbfPath && isQuarantinedOnlyGateFailure(phase, phaseFindings, blockingFindings);
        if (!phasePassed(phase.slot.op.name, output, ctx.storyId) && !quarantinedOnly) {
          getSafeLogger()?.warn("story-orchestrator", "Short-circuiting revalidation on phase failure", {
            storyId: ctx.storyId,
            phase: phase.slot.op.name,
          });
          shortCircuited = true;
          break;
        }
      }
      const postValidateFn = overrides?.postValidate ?? rectification.postValidate;
      const validated = postValidateFn ? await postValidateFn(findings, _validateCtx) : findings;
      return { findings: validated, shortCircuited };
    },
  };

  const cycleResult = await _storyOrchestratorDeps.runFixCycle(
    cycle,
    ctx as FixCycleContext,
    "story-orchestrator-rectification",
    { callOp: wrappedCallOp, declineBacking: declineSnapshot },
  );

  // Persist this cycle's iterations and declines into the run-scoped store together
  // so a later rectification re-entry for the same (storyId, tier) pair inherits the
  // accumulated history (US-003). Both are skipped together if runFixCycle throws.
  if (fixKey !== undefined && store && cycleResult.iterations.length > 0) {
    appendStoryFixIterations(store, fixKey, cycleResult.iterations);
  }
  if (fixKey !== undefined && store && declineSnapshot) {
    mergeStoryFixDeclines(store, fixKey, declineSnapshot);
  }

  // Source-agnostic oscillation counter (US-002). The runtime Map is the
  // stable run-scoped instance threaded across every per-attempt
  // PipelineContext rebuild, so the count accumulates across escalation
  // attempts and feeds the post-run circuit-breaker.
  const oscillationCount = countOscillationOutcomes(cycleResult.iterations);
  if (oscillationCount > 0) {
    recordOscillations(ctx.runtime.rectificationOscillations, ctx.storyId, oscillationCount);
  }

  // When the story-scoped budget is active and the cycle exited via
  // validate-short-circuit after prior iterations consumed part of the
  // per-strategy cap, the primary cause of exit is the cap, not the
  // short-circuit. Report max-attempts-per-strategy so downstream
  // consumers (ExecutionPlan resume, post-run inspection) route
  // the exhaustion correctly (US-003 AC6).
  const reportedExitReason =
    cycleResult.exitReason === "validate-short-circuit" && priorIterationCount > 0
      ? "max-attempts-per-strategy"
      : cycleResult.exitReason;

  phaseOutputs.rectification = {
    success: cycleResult.exitReason === "resolved",
    iterationCount: cycleResult.iterations.length,
    exitReason: reportedExitReason,
    finalFindingsCount: cycleResult.finalFindings.length,
  };

  // Rectification cycle summary — one line so the JSONL records what happened
  // (entry findings, iterations run, unfixed findings, exit reason, total cost).
  const rectLogger = getSafeLogger();
  const rectSummary = {
    storyId: ctx.storyId,
    initialFindingsCount: initialFindings.length,
    iterationCount: cycleResult.iterations.length,
    finalFindingsCount: cycleResult.finalFindings.length,
    exitReason: reportedExitReason,
    costUsd: cycleResult.costUsd,
  };
  if (cycleResult.exitReason === "resolved") {
    rectLogger?.info("story-orchestrator", "Rectification resolved all findings", rectSummary);
  } else {
    rectLogger?.warn("story-orchestrator", `Rectification exited: ${cycleResult.exitReason}`, rectSummary);
  }

  // "validator-error" means runPhase threw during re-validation (e.g. session failure).
  // runFixCycle demotes it to a clean exit rather than throwing, so we surface it here
  // to prevent the failure from being completely silent.
  if (cycleResult.exitReason === "validator-error") {
    rectLogger?.warn("story-orchestrator", "rectification cycle aborted — validator infrastructure error", {
      storyId: ctx.storyId,
    });
  }

  // #1658 — the repo-scoped strategy edits outside story scope by design, and its
  // edits land in THIS story's commit. Record and announce that, or a reviewer
  // meeting an unrelated file in the diff has nothing to explain it. Attached to
  // every exit below, since the dispatch happened regardless of how the cycle ended.
  const repoScopedFixes = deriveRepoScopedFixes(cycleResult.iterations);
  if (repoScopedFixes.length > 0) {
    for (const fix of repoScopedFixes) {
      // warn, not info: a story carrying a repair it did not cause is worth a
      // reader stopping on, and an empty `filesChanged` is the sharper case —
      // the fallthrough spent a session, touched nothing, and the story may still
      // pass via the verifier-SSOT carve-out.
      rectLogger?.warn("story-orchestrator", "Story commit carries a repo-scoped repair", {
        storyId: ctx.storyId,
        triggeringTests: fix.triggeringTests,
        filesChanged: fix.filesChanged,
        findingsCleared: fix.findingsCleared,
        ...(fix.declinedReason ? { declinedReason: fix.declinedReason } : {}),
      });
    }
  }
  const repoScoped = repoScopedFixes.length > 0 ? { repoScopedFixes } : {};

  if (EXHAUSTED_EXIT_REASONS.has(cycleResult.exitReason) && cycleResult.finalFindings.length > 0) {
    return {
      ...repoScoped,
      rectificationExhausted: true,
      unfixedFindings: cycleResult.finalFindings,
      ...(cycleResult.unresolvedDetail ? { unresolvedDetail: cycleResult.unresolvedDetail } : {}),
    };
  }
  if (cycleResult.exitReason === "validate-short-circuit") {
    // Empty findings — surface the lite-scope-backfill flag so resume can still run.
    return { ...repoScoped, liteScopeIncomplete: true };
  }

  return repoScoped;
}
