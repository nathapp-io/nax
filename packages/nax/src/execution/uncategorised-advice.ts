/**
 * A1 caller 3 (spec §4.8): a TDD failure with no category used to pause blind.
 * The advisor rules instead — retry as lite, escalate a tier, or defer to a human
 * with its diagnosis attached. Plus the stage-end flush of heads-ups the fix
 * cycle queued (spec §12.4).
 */
import { join, relative } from "node:path";
import type { AdviceDecision, Advisor, AdvisorCallContext } from "@/advisor";
import { buildMenu, createAdvisor } from "@/advisor";
import { featureDir, isAdvisorCallerEnabled } from "@/config";
import type { CallContext } from "@/operations";
import type { PipelineContext, StageResult } from "@/pipeline/types";
import type { DecideFrame } from "./post-run-decide-action";
import { sendPostRunNotification } from "./post-run-notifications";

const OUTPUT_TAIL_CHARS = 2000;

export const _uncategorisedAdviceDeps = {
  createAdvisor: (actx: AdvisorCallContext): Advisor => createAdvisor(actx),
};

function callContextFor(ctx: PipelineContext): CallContext {
  return {
    runtime: ctx.runtime,
    packageView: ctx.packageView ?? ctx.runtime.packages.resolve(ctx.workdir),
    packageDir: ctx.workdir,
    config: ctx.config,
    agentName: ctx.agentManager?.getDefault() ?? "claude",
    featureName: ctx.prd.feature,
    storyId: ctx.story.id,
  };
}

function headsUpVia(ctx: PipelineContext) {
  return async (text: string) => {
    await sendPostRunNotification(ctx, {
      idPrefix: "advisor",
      summary: `Advisor decision needs confirmation: ${ctx.story.id}`,
      detail: text,
      failureMessage: "Failed to send advisor heads-up",
    });
    return ctx.interaction ? { sent: true } : { sent: false, reason: "no-interaction-channel" };
  };
}

function toStageResult(d: AdviceDecision, ctx: PipelineContext, pauseReason: string): StageResult | null {
  switch (d.action.type) {
    case "retry-as-lite":
      ctx.retryAsLite = true;
      return { action: "escalate", reason: `TDD uncategorised: retry as lite [advisor ${d.id}]` };
    case "escalate-tier":
      return { action: "escalate", reason: `${d.rationale} [advisor ${d.id}]` };
    case "defer":
      return { action: "pause", reason: `${pauseReason} [advisor ${d.id}: ${d.rationale}]` };
    default:
      return null;
  }
}

/** Caller 3. `null` = not applicable or the advisor fell back: the caller pauses as today. */
export async function adviseUncategorised(frame: DecideFrame, pauseReason: string): Promise<StageResult | null> {
  const { ctx, planResult, inspection, opts } = frame;
  if (!isAdvisorCallerEnabled(ctx.config, "uncategorisedFailure")) return null;
  const repoRoot = ctx.runtime.workdir;
  const feature = ctx.prd.feature;
  const advisor = _uncategorisedAdviceDeps.createAdvisor({
    callCtx: callContextFor(ctx),
    repoRoot,
    outputDir: ctx.runtime.outputDir,
    feature,
    runId: ctx.runtime.runId,
    specPath: relative(repoRoot, join(featureDir(repoRoot, feature), "spec.md")),
    workdir: ctx.workdir,
    headsUp: headsUpVia(ctx),
  });
  const failed = planResult.failedPhases?.join(", ") ?? "unknown";
  const { decision } = await advisor.advise({
    kind: "uncategorised-failure",
    feature,
    storyId: ctx.story.id,
    summary: `Story ${ctx.story.id} failed with no failure category (failed phases: ${failed}).`,
    evidence: [
      { source: "review-round", ref: "failed phases", text: failed },
      { source: "test-output", text: inspection.combinedOutput.slice(-OUTPUT_TAIL_CHARS) },
    ],
    options: buildMenu({
      kind: "uncategorised-failure",
      isThreeSession: opts.tddMode !== null,
      isLite: opts.tddMode?.isLite ?? false,
    }),
  });
  return decision ? toStageResult(decision, ctx, pauseReason) : null;
}

/** Stage end: send the heads-ups the fix cycle queued for this story (it has no channel of its own). */
export async function flushAdvisorHeadsUps(ctx: PipelineContext): Promise<void> {
  for (const text of ctx.runtime.advisorHeadsUps.drain(ctx.story.id)) {
    await sendPostRunNotification(ctx, {
      idPrefix: "advisor",
      summary: `Advisor decision needs confirmation: ${ctx.story.id}`,
      detail: text,
      failureMessage: "Failed to send advisor heads-up",
    });
  }
}
