/**
 * The heads-up channel an advisor calls to flag a decision it could not settle
 * on its own.
 *
 * This module is all that survived the post-run inspection cut (US-003): the
 * "uncategorised TDD failure" caller and its stage-end flush are gone with the
 * inspection layer, but the channel is still consumed in production —
 * `src/workflow/stage-env.ts` spreads it into `createAdvisor` so the workflow
 * advisor can reach the run's interaction chain without owning one.
 */
import type { AdvisorCallContext } from "@/advisor";
import type { PipelineContext } from "@/pipeline/types";
import { sendPostRunNotification } from "./post-run-notifications";

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

/** The heads-up channel createAdvisor takes (used by the workflow advisor). */
export function headsUpChannel(ctx: PipelineContext): Pick<AdvisorCallContext, "headsUp"> {
  return { headsUp: headsUpVia(ctx) };
}
