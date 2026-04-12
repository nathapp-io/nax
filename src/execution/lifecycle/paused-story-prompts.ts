/**
 * Paused Story Prompts
 *
 * On re-run, asks the user what to do with each paused story:
 * - Resume: reset to pending, retried this run
 * - Skip: mark as skipped, not retried
 * - Keep paused: leave as-is, skipped for this run
 *
 * In headless mode the caller skips this entirely — paused stories stay paused.
 */

import type { InteractionChain } from "../../interaction/chain";
import type { InteractionResponse } from "../../interaction/types";
import { getSafeLogger } from "../../logger";
import type { PRD } from "../../prd/types";

export interface PausedStoryPromptSummary {
  resumed: string[];
  skipped: string[];
  kept: string[];
}

/**
 * Prompt the user for each paused story on re-run.
 * Mutates prd.userStories statuses in place.
 * Returns a summary of decisions so the caller can save + recount.
 *
 * @param storyIsolation - When `"worktree"`, clears `storyGitRef` for resumed stories so a
 *   fresh ref is captured in the new worktree on the next run.
 */
export async function promptForPausedStories(
  prd: PRD,
  chain: InteractionChain,
  featureName: string,
  storyIsolation?: "shared" | "worktree",
): Promise<PausedStoryPromptSummary> {
  const logger = getSafeLogger();
  const summary: PausedStoryPromptSummary = { resumed: [], skipped: [], kept: [] };

  const pausedStories = prd.userStories.filter((s) => s.status === "paused");

  for (const story of pausedStories) {
    // Sanitize: agent errors often contain multi-line stack traces (#356)
    const lastReason = (story.priorErrors?.slice(-1)[0] ?? "no reason recorded").replace(/\n/g, " ").slice(0, 200);

    logger?.info("run-initialization", "Paused story found — prompting user", {
      storyId: story.id,
      attempts: story.attempts,
    });

    const response: InteractionResponse = await chain.prompt({
      id: `ix-${story.id}-paused-resume`,
      type: "choose",
      featureName,
      storyId: story.id,
      stage: "pre-flight",
      summary: `Story ${story.id} is paused — how to proceed?`,
      detail: `"${story.title}"\nLast reason: ${lastReason}\nAttempts so far: ${story.attempts}`,
      options: [
        { key: "resume", label: "Resume", description: "Reset to pending and retry on this run" },
        { key: "skip", label: "Skip", description: "Mark as skipped, won't be retried" },
        { key: "keep", label: "Keep paused", description: "Leave paused, skip for this run" },
      ],
      timeout: 300_000, // 5 minutes
      fallback: "continue",
      createdAt: Date.now(),
    });

    // Apply fallback so timeout → "approve" instead of "skip" (#356).
    // Without this, a timed-out prompt hits case "skip" and permanently skips the story.
    const effectiveAction = chain.applyFallback(response, "continue");
    const resolvedKey = effectiveAction === "approve" ? "keep" : (effectiveAction as string);

    switch (resolvedKey) {
      case "resume": {
        story.status = "pending";
        // EXEC-002: Clear storyGitRef so it is re-captured in the fresh worktree.
        if (storyIsolation === "worktree") {
          story.storyGitRef = undefined;
        }
        summary.resumed.push(story.id);
        logger?.info("run-initialization", "User resumed paused story", { storyId: story.id });
        break;
      }
      case "skip": {
        story.status = "skipped";
        summary.skipped.push(story.id);
        logger?.info("run-initialization", "User skipped paused story", { storyId: story.id });
        break;
      }
      default: {
        // "keep" or timeout fallback — leave paused, excluded from this run
        summary.kept.push(story.id);
        logger?.info("run-initialization", "Keeping story paused", { storyId: story.id });
        break;
      }
    }
  }

  return summary;
}
