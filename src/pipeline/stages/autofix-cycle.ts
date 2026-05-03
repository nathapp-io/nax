/**
 * ADR-022 Phase 7 — runAgentRectificationV2
 *
 * Drives the autofix cycle using runFixCycle with two co-run-sequential strategies:
 *   - autofix-implementer: source-targeted findings (maxAttempts from config)
 *   - autofix-test-writer: test-targeted findings (maxAttempts 1)
 *
 * Activated via quality.autofix.cycleV2 = true (default off).
 * Shadow mode writes divergence snapshots for comparison with legacy routing.
 *
 * Known V2 limitations (tracked for future iterations):
 *   - lintFixCmd / formatFixCmd mechanical shortcuts are not run before agent sessions.
 *     Legacy ran these cheaply (~77ms) to avoid full agent sessions for auto-fixable lint.
 *   - cost telemetry returns 0 — agent cost is not surfaced from op output type yet.
 *   - recheckReview is called unconditionally, skipping the no-op diff optimisation
 *     the legacy path uses to avoid re-running LLM-driven review on unchanged diffs.
 *
 * scope: repo-scoped (closes over outer PipelineContext for recheckReview + config).
 */

import { join } from "node:path";
import type { AutofixConfig } from "../../config/selectors";
import type { Finding, FixCycle, FixCycleContext, FixCycleResult, FixStrategy } from "../../findings";
import { runFixCycle } from "../../findings";
import { getLogger } from "../../logger";
import { implementerRectifyOp, testWriterRectifyOp } from "../../operations";
import type { AutofixImplementerInput, AutofixImplementerOutput } from "../../operations";
import type { AutofixTestWriterInput } from "../../operations";
import type { ReviewCheckResult } from "../../review/types";
import type { PipelineContext } from "../types";
import { _autofixDeps } from "./autofix";

// ─── Context conversion ───────────────────────────────────────────────────────

function fixCallCtx(ctx: PipelineContext): FixCycleContext {
  const packageView = ctx.packageView ?? ctx.runtime.packages.repo();
  return {
    runtime: ctx.runtime,
    packageView,
    packageDir: ctx.workdir,
    storyId: ctx.story.id,
    featureName: ctx.prd.feature,
    agentName: ctx.agentManager.getDefault(),
    story: ctx.story,
  };
}

// ─── Finding collection ───────────────────────────────────────────────────────

function collectFailedChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return (ctx.reviewResult?.checks ?? []).filter((c) => !c.success);
}

/**
 * Collect structured findings from the current review result.
 * Synthesizes one finding per check for mechanical checks without structured findings
 * so the cycle has something to act on even when findings[] is unpopulated.
 */
function collectCurrentFindings(ctx: PipelineContext): Finding[] {
  const checks = collectFailedChecks(ctx);
  if (checks.length === 0) return [];

  return checks.flatMap((c): Finding[] => {
    if (c.findings?.length) return c.findings;
    // Synthesize a minimal finding for mechanical checks without structured output
    return [
      {
        source: c.check === "adversarial" ? "adversarial-review" : c.check === "semantic" ? "semantic-review" : "lint",
        severity: "error",
        category: c.check,
        message: (c.output ?? c.check).slice(0, 200),
        fixTarget: "source",
      },
    ];
  });
}

function collectTestTargetedChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return collectFailedChecks(ctx).filter((c) => c.findings?.some((f) => f.fixTarget === "test"));
}

// ─── Strategies ───────────────────────────────────────────────────────────────

function buildAutofixStrategies(
  ctx: PipelineContext,
  maxAttempts: number,
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous strategy array; I/O types are opaque to cycle layer
): FixStrategy<Finding, any, any, AutofixConfig>[] {
  const implementer: FixStrategy<Finding, AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig> = {
    name: "autofix-implementer",
    appliesTo: (f) => (f.fixTarget ?? "source") === "source",
    fixOp: implementerRectifyOp,
    maxAttempts,
    coRun: "co-run-sequential",
    buildInput: (_findings, _prior, _cycleCtx): AutofixImplementerInput => ({
      failedChecks: collectFailedChecks(ctx),
      story: ctx.story,
    }),
    extractApplied: (output) => ({
      // Surface the UNRESOLVED sentinel in summary so post-cycle scan can detect it
      summary: output.unresolvedReason ?? "",
    }),
  };

  const testWriter: FixStrategy<Finding, AutofixTestWriterInput, { applied: true }, AutofixConfig> = {
    name: "autofix-test-writer",
    appliesTo: (f) => f.fixTarget === "test",
    fixOp: testWriterRectifyOp,
    maxAttempts: 1,
    coRun: "co-run-sequential",
    buildInput: (_findings, _prior, _cycleCtx): AutofixTestWriterInput => ({
      failedChecks: collectTestTargetedChecks(ctx),
      story: ctx.story,
    }),
  };

  return [implementer, testWriter];
}

// ─── UNRESOLVED detection ─────────────────────────────────────────────────────

/**
 * Scan iteration history for an UNRESOLVED sentinel emitted by the implementer.
 * The reason is surfaced via extractApplied.summary on the autofix-implementer strategy.
 */
function findUnresolvedReason(result: FixCycleResult<Finding>): string | undefined {
  for (const iter of result.iterations) {
    for (const fa of iter.fixesApplied) {
      if (fa.strategyName === "autofix-implementer" && fa.summary) {
        return fa.summary;
      }
    }
  }
  return undefined;
}

// ─── Shadow mode ──────────────────────────────────────────────────────────────

interface ShadowReport {
  storyId: string;
  timestamp: string;
  initialFindingsCount: number;
  exitReason: FixCycleResult<Finding>["exitReason"];
  iterations: number;
  finalFindingsCount: number;
  exhaustedStrategy?: string;
}

async function writeShadowReport(
  ctx: PipelineContext,
  result: FixCycleResult<Finding>,
  initialFindingsCount: number,
): Promise<void> {
  const logger = getLogger();
  const shadowDir = join(ctx.workdir, ".nax", "cycle-shadow", ctx.story.id);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report: ShadowReport = {
    storyId: ctx.story.id,
    timestamp,
    initialFindingsCount,
    exitReason: result.exitReason,
    iterations: result.iterations.length,
    finalFindingsCount: result.finalFindings.length,
    ...(result.exhaustedStrategy ? { exhaustedStrategy: result.exhaustedStrategy } : {}),
  };
  try {
    const file = join(shadowDir, `${timestamp}.json`);
    await Bun.write(file, JSON.stringify(report, null, 2));
  } catch (err) {
    logger.debug("autofix-cycle", "Shadow report write failed (non-fatal)", {
      storyId: ctx.story.id,
      error: String(err),
    });
  }
}

// ─── V2 entry point ───────────────────────────────────────────────────────────

/**
 * V2 autofix via runFixCycle. Mirrors the return contract of runAgentRectification.
 */
export async function runAgentRectificationV2(
  ctx: PipelineContext,
  _lintFixCmd: string | undefined,
  _formatFixCmd: string | undefined,
  _effectiveWorkdir: string,
): Promise<{ succeeded: boolean; cost: number; unresolvedReason?: string }> {
  const logger = getLogger();
  const storyId = ctx.story.id;

  const cycleCtx = fixCallCtx(ctx);
  const initialFindings = collectCurrentFindings(ctx);
  const maxAttempts = ctx.config.quality.autofix?.maxAttempts ?? 3;
  const maxTotalAttempts = ctx.config.quality.autofix?.maxTotalAttempts ?? 12;

  logger.info("autofix-cycle", "Starting V2 fix cycle", {
    storyId,
    initialFindingsCount: initialFindings.length,
    maxAttempts,
    maxTotalAttempts,
  });

  const cycle: FixCycle<Finding> = {
    findings: initialFindings,
    iterations: [...(ctx.autofixPriorIterations ?? [])],
    strategies: buildAutofixStrategies(ctx, maxAttempts),
    config: {
      maxAttemptsTotal: maxTotalAttempts,
      validatorRetries: 1,
    },
    async validate(_cycleCtx: FixCycleContext): Promise<Finding[]> {
      // recheckReview mutates ctx.reviewResult; subsequent buildInput reads fresh state
      await _autofixDeps.recheckReview(ctx);
      return collectCurrentFindings(ctx);
    },
  };

  const result = await runFixCycle(cycle, cycleCtx, "autofix-v2");

  // Persist iterations for next pipeline retry
  ctx.autofixPriorIterations = result.iterations;

  await writeShadowReport(ctx, result, initialFindings.length);

  const unresolvedReason = findUnresolvedReason(result);
  const succeeded = result.exitReason === "resolved" || result.finalFindings.length === 0;

  logger.info("autofix-cycle", "V2 fix cycle complete", {
    storyId,
    exitReason: result.exitReason,
    iterations: result.iterations.length,
    finalFindingsCount: result.finalFindings.length,
    succeeded,
    ...(unresolvedReason ? { unresolvedReason } : {}),
  });

  return { succeeded, cost: 0, ...(unresolvedReason ? { unresolvedReason } : {}) };
}
