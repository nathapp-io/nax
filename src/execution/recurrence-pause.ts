/**
 * Cross-attempt review-recurrence breaker consumption (#1666 Part C).
 *
 * Split out of `post-run.ts` (600-line file-size limit) so the "check the
 * breaker, notify, pause" sequence stays testable on its own — it mirrors the
 * inline oscillation-breaker handling `decideStageAction` keeps, just for the
 * parallel cross-attempt counter.
 */
import type { Logger } from "../logger";
import type { PipelineContext, StageResult } from "../pipeline/types";
import { errorMessage } from "../utils/errors";
import { inspectRecurrenceBreaker } from "./recurrence-breaker";

/**
 * Checks `inspectRecurrenceBreaker` and, if tripped, notifies (best-effort) and
 * returns a `{ action: "pause" }` StageResult. Returns `undefined` when the
 * breaker did not trip, so the caller falls through to its normal escalate path.
 */
export async function maybeHandleRecurrenceBreaker(
  ctx: PipelineContext,
  logger: Logger,
): Promise<StageResult | undefined> {
  const decision = inspectRecurrenceBreaker(ctx);
  if (!decision.trip) return undefined;

  logger.warn("execution", "Cross-attempt review-recurrence circuit-breaker paused story", {
    storyId: ctx.story.id,
    source: decision.source,
    recurrenceCount: decision.count,
    maxCrossAttemptRecurrences: decision.maxCrossAttemptRecurrences,
  });

  if (ctx.interaction) {
    try {
      await ctx.interaction.send({
        id: `review-recurrence-${ctx.story.id}-${Date.now()}`,
        type: "notify",
        featureName: ctx.featureDir ? (ctx.featureDir.split("/").pop() ?? "unknown") : "unknown",
        storyId: ctx.story.id,
        stage: "execution",
        summary: `Review deadlock paused: ${ctx.story.id}`,
        detail: `Story: ${ctx.story.title}\nReason: ${decision.reason}`,
        fallback: "continue",
        createdAt: Date.now(),
      });
    } catch (notifyErr) {
      logger.warn("execution", "Failed to send review-recurrence pause notification", {
        storyId: ctx.story.id,
        error: errorMessage(notifyErr),
      });
    }
  }

  return { action: "pause", reason: decision.reason };
}
