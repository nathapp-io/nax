/**
 * Review #20: `before_turn_end` also fires when a turn throws, so a handler
 * sees every ending. The result is ignored on this path -- there is no turn
 * left to continue. The dispatch is awaited without a timeout of its own: a
 * plugin handler is timed by its wrapper (`wrapExternalHandler`, US-002),
 * and a built-in handler is not timed at all.
 */
import { getSafeLogger } from "@/logger";
import type { LoopEventRegistry } from "./loop-events";
import type { BeforeTurnEndPayload } from "./loop-events/types";

export async function dispatchTurnEndOnError(
  loopEvents: LoopEventRegistry,
  payload: Omit<BeforeTurnEndPayload, "ended">,
  signal?: AbortSignal,
): Promise<void> {
  const patch = await loopEvents.dispatch("before_turn_end", {
    ...payload,
    ended: signal?.aborted === true ? "aborted" : "errored",
  });
  if (patch.followUp !== undefined) {
    getSafeLogger()?.warn("native-loop-events", "before_turn_end followUp ignored on error path", {});
  }
}
