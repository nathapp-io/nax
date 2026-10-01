import { getLogger } from "../logger";
import type { PipelineContext } from "../pipeline/types";
import { errorMessage } from "../utils/errors";

export interface PostRunNotification {
  readonly idPrefix: string;
  readonly summary: string;
  readonly detail: string;
  readonly failureMessage: string;
}

/** Send a best-effort execution notification without changing the stage decision. */
export async function sendPostRunNotification(ctx: PipelineContext, notification: PostRunNotification): Promise<void> {
  if (!ctx.interaction) return;
  try {
    await ctx.interaction.send({
      id: `${notification.idPrefix}-${ctx.story.id}-${Date.now()}`,
      type: "notify",
      featureName: ctx.featureDir ? (ctx.featureDir.split("/").pop() ?? "unknown") : "unknown",
      storyId: ctx.story.id,
      stage: "execution",
      summary: notification.summary,
      detail: notification.detail,
      fallback: "continue",
      createdAt: Date.now(),
    });
  } catch (err) {
    getLogger().warn("execution", notification.failureMessage, { storyId: ctx.story.id, error: errorMessage(err) });
  }
}
