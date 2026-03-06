// RE-ARCH: keep
/**
 * Interaction Subscriber (ADR-005, Phase 3 US-P3-003)
 *
 * Maps pipeline events to interaction trigger calls.
 * Currently handles:
 *   - human-review:requested → executeTrigger("human-review")
 *
 * Future triggers (story-ambiguity, merge-conflict, etc.) can be added
 * by subscribing to the appropriate events.
 *
 * Design:
 * - Interaction triggers MAY block (await user response) — uses emitAsync where needed
 * - Errors are caught and logged; never rethrown to avoid blocking the pipeline
 * - Returns unsubscribe function for cleanup
 */

import type { NaxConfig } from "../../config";
import type { InteractionChain } from "../../interaction/chain";
import { executeTrigger, isTriggerEnabled } from "../../interaction/triggers";
import { getSafeLogger } from "../../logger";
import type { PipelineEventBus } from "../event-bus";
import type { UnsubscribeFn } from "./hooks";

/**
 * Wire interaction triggers to the event bus.
 *
 * @param bus              - The pipeline event bus
 * @param interactionChain - The active interaction chain (may be null)
 * @param config           - Nax config (for isTriggerEnabled checks)
 * @returns Unsubscribe function
 */
export function wireInteraction(
  bus: PipelineEventBus,
  interactionChain: InteractionChain | null | undefined,
  config: NaxConfig,
): UnsubscribeFn {
  const logger = getSafeLogger();
  const unsubs: UnsubscribeFn[] = [];

  // human-review:requested → executeTrigger("human-review")
  if (interactionChain && isTriggerEnabled("human-review", config)) {
    unsubs.push(
      bus.on("human-review:requested", (ev) => {
        executeTrigger(
          "human-review",
          {
            featureName: ev.feature ?? "",
            storyId: ev.storyId,
            iteration: ev.attempts ?? 0,
            reason: ev.reason,
          },
          config,
          interactionChain,
        ).catch((err) => {
          logger?.warn("interaction-subscriber", "human-review trigger failed", {
            storyId: ev.storyId,
            error: String(err),
          });
        });
      }),
    );
  }

  return () => {
    for (const u of unsubs) u();
  };
}
