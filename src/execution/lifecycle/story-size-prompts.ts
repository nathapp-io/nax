/**
 * Story Size Prompts (v0.16.0)
 *
 * Post-precheck interaction prompts for flagged stories.
 * Asks user to confirm (Approve/Skip/Abort) for each large story.
 * Integrates with interaction chain.
 */

import type { InteractionChain } from "../../interaction/chain";
import type { InteractionResponse } from "../../interaction/types";
import { getSafeLogger } from "../../logger";
import type { PRD } from "../../prd/types";
import type { FlaggedStory } from "../../precheck/story-size-gate";

/** Prompt result for a single story */
export interface StoryPromptResult {
  storyId: string;
  action: "approve" | "skip" | "abort";
}

/** Summary of story size prompt results */
export interface StorySizePromptSummary {
  approved: string[];
  skipped: string[];
  aborted: boolean;
}

/**
 * Prompt user for each flagged story
 *
 * @param flaggedStories - Stories that exceeded size thresholds
 * @param prd - PRD instance (mutated: skips stories if user selects Skip)
 * @param chain - Interaction chain
 * @param featureName - Feature name for context
 * @returns Summary of user decisions
 */
export async function promptForFlaggedStories(
  flaggedStories: FlaggedStory[],
  prd: PRD,
  chain: InteractionChain,
  featureName: string,
): Promise<StorySizePromptSummary> {
  const logger = getSafeLogger();
  const summary: StorySizePromptSummary = {
    approved: [],
    skipped: [],
    aborted: false,
  };

  for (const flagged of flaggedStories) {
    logger?.info("precheck", `Story size gate: prompting for ${flagged.storyId}`, {
      recommendation: flagged.recommendation,
    });

    const story = prd.userStories.find((s) => s.id === flagged.storyId);
    if (!story) {
      logger?.warn("precheck", `Story ${flagged.storyId} not found in PRD, skipping prompt`);
      continue;
    }

    // Build detail message with signal breakdown
    const signalDetails = [
      `- Acceptance Criteria: ${flagged.signals.acCount.value} (threshold: ${flagged.signals.acCount.threshold}) ${flagged.signals.acCount.flagged ? "⚠" : "✓"}`,
      `- Description Length: ${flagged.signals.descriptionLength.value} chars (threshold: ${flagged.signals.descriptionLength.threshold}) ${flagged.signals.descriptionLength.flagged ? "⚠" : "✓"}`,
      `- Bullet Points: ${flagged.signals.bulletPoints.value} (threshold: ${flagged.signals.bulletPoints.threshold}) ${flagged.signals.bulletPoints.flagged ? "⚠" : "✓"}`,
    ];

    const detail = `${flagged.recommendation}\n\nSignal breakdown:\n${signalDetails.join("\n")}\n\nStory: ${story.title}`;

    // Send interaction request
    const requestId = `ix-${flagged.storyId}-size-gate`;
    const response: InteractionResponse = await chain.prompt({
      id: requestId,
      type: "choose",
      featureName,
      storyId: flagged.storyId,
      stage: "pre-flight",
      summary: `Story ${flagged.storyId} exceeds size thresholds — proceed?`,
      detail,
      options: [
        { key: "approve", label: "Approve", description: "Continue with this story despite size warnings" },
        { key: "skip", label: "Skip", description: "Skip this story and continue with others" },
        { key: "abort", label: "Abort", description: "Abort the entire run" },
      ],
      timeout: 600000, // 10 minutes
      fallback: "escalate",
      createdAt: Date.now(),
    });

    // Process response
    switch (response.action) {
      case "approve": {
        summary.approved.push(flagged.storyId);
        logger?.info("precheck", `User approved ${flagged.storyId} despite size warnings`);
        break;
      }
      case "skip": {
        summary.skipped.push(flagged.storyId);
        story.status = "skipped";
        logger?.info("precheck", `User skipped ${flagged.storyId} due to size warnings`);
        break;
      }
      case "abort": {
        summary.aborted = true;
        logger?.warn("precheck", `User aborted run due to ${flagged.storyId} size warnings`);
        throw new Error(`Run aborted by user: story ${flagged.storyId} exceeds size thresholds`);
      }
      default: {
        logger?.warn("precheck", `Unknown action ${response.action} for ${flagged.storyId}, aborting`);
        summary.aborted = true;
        throw new Error(`Run aborted: unknown action ${response.action}`);
      }
    }
  }

  logger?.info("precheck", "Story size gate prompts complete", {
    approved: summary.approved.length,
    skipped: summary.skipped.length,
    aborted: summary.aborted,
  });

  return summary;
}
