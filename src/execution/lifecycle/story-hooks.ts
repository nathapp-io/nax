/**
 * Story Lifecycle Hooks
 *
 * Centralizes reporter notification boilerplate for story lifecycle events:
 * - onStoryComplete (completed/paused/skipped/failed)
 */

import { getSafeLogger } from "../../logger";
import type { IReporter } from "../../plugins/types";

export interface StoryCompleteEvent {
  runId: string;
  storyId: string;
  status: "completed" | "paused" | "skipped" | "failed";
  durationMs: number;
  cost: number;
  tier: string;
  testStrategy: string;
}

/**
 * Emit onStoryComplete event to all reporters
 *
 * Handles error recovery for individual reporter failures.
 */
export async function emitStoryComplete(reporters: IReporter[], event: StoryCompleteEvent): Promise<void> {
  const logger = getSafeLogger();

  for (const reporter of reporters) {
    if (reporter.onStoryComplete) {
      try {
        await reporter.onStoryComplete(event);
      } catch (error) {
        logger?.warn("plugins", `Reporter '${reporter.name}' onStoryComplete failed`, { error });
      }
    }
  }
}
