/**
 * Triage seam — shared between the orchestrator wiring and the production
 * binding to the real `triageFlakyFindings`. Lives in its own module (no
 * `rectification.ts` / `run-phase.ts` dependency) so both
 * `_storyOrchestratorDeps.triage` initialization and the orchestrator's
 * `triageGateFindings` import this without creating a circular import
 * between the two orchestrator files.
 */

import type { Finding } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import { detectFramework } from "@/test-runners";
import { errorMessage } from "@/utils/errors";
import { type QuarantineMemo, logFlakeTriageSkip, resolveFlakeBaselineDiff, triageFlakyFindings } from "@/verification";

/** Triage result tuple shape — produced by `_storyOrchestratorDeps.triage`. */
export type TriageResult = readonly [Finding[], { quarantinedKeys: readonly string[]; flakeTriageRan?: boolean }];

/** Context the seam needs beyond the gate's findings — supplied by the caller (`triageGateFindings`). */
export interface TriageSeamContext {
  readonly ctx: CallContext;
  /** Raw full-suite-gate test-runner output, for `detectFramework()`. */
  readonly rawOutput: string;
  /** Optional transaction-local memo used by ADR-024 NBF revalidation. */
  readonly quarantineMemo?: QuarantineMemo;
}

/**
 * Triage seam signature — the orchestrator hands the gate's `failed-test`
 * findings (plus the seam context) to this function and receives the triaged
 * set (entries may have been relabeled to `category: "flaky-test"` and
 * quarantined for the run) plus the memo keys of every entry quarantined on
 * this call.
 *
 * Async by contract: the real `triageFlakyFindings` (src/verification/flake-triage.ts)
 * is async because it probes subprocesses for isolation re-runs.
 *
 * Receives the gate's failed-test findings only (post-`extractPhaseFindings`
 * filter); the seam must NOT re-read or re-validate the gate output.
 */
export type TriageSeam = (gateFindings: Finding[], seamCtx: TriageSeamContext) => Promise<TriageResult>;

/**
 * Default (no-op) triage seam — a passthrough that returns findings
 * unchanged with an empty quarantine report. Used only where no real story
 * context is available (never wired in production — see `productionTriageSeam`).
 */
export const defaultTriageSeam: TriageSeam = async (gateFindings) => [
  gateFindings,
  { quarantinedKeys: [], flakeTriageRan: false },
];

/**
 * Production triage seam — binds `triageFlakyFindings` (US-002) to the
 * story's real context: resolved flake-detection config, detected framework
 * (from the gate's raw output), the package's base test command, and a
 * baseline diff (changed/mapped test files since the merge-base) so
 * story-authored or story-touched tests are never quarantined (spec: "stay
 * strict" on agent-written/newly-modified tests).
 *
 * Fails closed: any error resolving the diff, command, or framework leaves
 * findings unchanged (no quarantine) rather than risking a false quarantine.
 * `triageFlakyFindings` itself already fails closed on probe errors.
 */
export const productionTriageSeam: TriageSeam = async (gateFindings, { ctx, rawOutput, quarantineMemo }) => {
  const config = ctx.packageView.config;
  const flakeDetection = config.execution?.flakeDetection;
  if (!flakeDetection?.enabled) {
    return [gateFindings, { quarantinedKeys: [], flakeTriageRan: false }];
  }

  // #1657: every bail-out below leaves the surviving findings looking
  // deterministic to the repo-scoped-test-fix fallthrough. `candidateBasis` is
  // "gate-findings" and not "probe-eligible" because the baseline diff that
  // narrows candidates does not exist yet on these paths — the count is an
  // upper bound. `flakeDetection.enabled: false` is not counted: an operator
  // opt-out is not a gap in a feature believed to be on.
  const candidateCount = gateFindings.length;
  const storyId = ctx.storyId;

  const framework = detectFramework(rawOutput);
  if (framework === "unknown") {
    logFlakeTriageSkip({ reason: "framework-undetected", candidateCount, candidateBasis: "gate-findings", storyId });
    return [gateFindings, { quarantinedKeys: [], flakeTriageRan: false }];
  }

  try {
    // Read inside the try so the catch covers every resolution this seam does,
    // as its contract above promises — a malformed context must skip triage
    // with a counter, not throw past the seam.
    const workdir = ctx.runtime.workdir;
    const storyWorkdir = ctx.story?.workdir;
    const { resolveQualityTestCommands } = await import("@/quality");
    const { testCommand } = await resolveQualityTestCommands(config, workdir, storyWorkdir);
    const baseCommand = testCommand ?? config.quality?.commands?.test;
    if (!baseCommand) {
      logFlakeTriageSkip({ reason: "no-test-command", candidateCount, candidateBasis: "gate-findings", storyId });
      return [gateFindings, { quarantinedKeys: [], flakeTriageRan: false }];
    }

    const diff = await resolveFlakeBaselineDiff(config, workdir, storyWorkdir);
    if (diff === null) {
      logFlakeTriageSkip({
        reason: "baseline-diff-unresolved",
        candidateCount,
        candidateBasis: "gate-findings",
        storyId,
      });
      return [gateFindings, { quarantinedKeys: [], flakeTriageRan: false }];
    }

    const result = await triageFlakyFindings({
      findings: gateFindings,
      diff,
      flakeDetection,
      baseCommand,
      cwd: ctx.packageDir,
      framework,
      quarantineMemo: quarantineMemo ?? ctx.runtime.quarantineMemo,
      storyId,
    });
    return [result.findings, { quarantinedKeys: result.quarantineReport.keys, flakeTriageRan: true }];
  } catch (err) {
    getSafeLogger()?.warn(
      "story-orchestrator",
      "Flake triage seam failed resolving context — keeping findings blocking (no quarantine)",
      {
        storyId,
        error: errorMessage(err),
      },
    );
    logFlakeTriageSkip({
      reason: "context-error",
      candidateCount,
      candidateBasis: "gate-findings",
      storyId,
      error: errorMessage(err),
    });
    return [gateFindings, { quarantinedKeys: [], flakeTriageRan: false }];
  }
};
