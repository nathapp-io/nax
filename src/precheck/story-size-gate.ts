/**
 * Story Size Gate (v0.16.0)
 *
 * Detects user stories that are too large (waste tokens, yield poor output).
 * Uses heuristic signals: AC count, description length, bullet point count.
 * Returns Tier 2 warning with flaggedStory metadata for interaction prompts.
 */

import type { NaxConfig } from "../config";
import type { PRD, UserStory } from "../prd/types";
import type { Check } from "./types";

/** Flagged story metadata */
export interface FlaggedStory {
  storyId: string;
  signals: {
    acCount: { value: number; threshold: number; flagged: boolean };
    descriptionLength: { value: number; threshold: number; flagged: boolean };
    bulletPoints: { value: number; threshold: number; flagged: boolean };
  };
  recommendation: string;
}

/** Story size gate result with metadata */
export interface StorySizeGateResult {
  check: Check;
  flaggedStories: FlaggedStory[];
}

/**
 * Count bullet points in text (lines starting with -, *, •, or digit.)
 */
function countBulletPoints(text: string): number {
  const lines = text.split("\n");
  const bulletPattern = /^\s*[-*•]|\d+\./;
  return lines.filter((line) => bulletPattern.test(line)).length;
}

/**
 * Analyze a single story for size signals
 */
function analyzeStory(story: UserStory, config: NaxConfig): FlaggedStory | null {
  const thresholds = config.precheck?.storySizeGate ?? {
    enabled: true,
    maxAcCount: 6,
    maxDescriptionLength: 2000,
    maxBulletPoints: 8,
  };

  const acCount = story.acceptanceCriteria.length;
  const descriptionLength = story.description.length;
  const bulletPoints = countBulletPoints(story.description);

  const acFlagged = acCount > thresholds.maxAcCount;
  const descFlagged = descriptionLength > thresholds.maxDescriptionLength;
  const bulletsFlagged = bulletPoints > thresholds.maxBulletPoints;

  // Only flag if at least one signal exceeds threshold
  if (!acFlagged && !descFlagged && !bulletsFlagged) {
    return null;
  }

  const signals = {
    acCount: { value: acCount, threshold: thresholds.maxAcCount, flagged: acFlagged },
    descriptionLength: {
      value: descriptionLength,
      threshold: thresholds.maxDescriptionLength,
      flagged: descFlagged,
    },
    bulletPoints: { value: bulletPoints, threshold: thresholds.maxBulletPoints, flagged: bulletsFlagged },
  };

  // Build recommendation message
  const flaggedSignals = [];
  if (acFlagged) flaggedSignals.push(`${acCount} AC (max ${thresholds.maxAcCount})`);
  if (descFlagged) flaggedSignals.push(`${descriptionLength} chars (max ${thresholds.maxDescriptionLength})`);
  if (bulletsFlagged) flaggedSignals.push(`${bulletPoints} bullets (max ${thresholds.maxBulletPoints})`);

  return {
    storyId: story.id,
    signals,
    recommendation: `Story ${story.id} is too large: ${flaggedSignals.join(", ")}. Consider splitting into smaller stories.`,
  };
}

/**
 * Check story size gate for all pending stories
 */
export async function checkStorySizeGate(config: NaxConfig, prd: PRD): Promise<StorySizeGateResult> {
  const gateConfig = config.precheck?.storySizeGate ?? {
    enabled: true,
    maxAcCount: 6,
    maxDescriptionLength: 2000,
    maxBulletPoints: 8,
  };

  // Gate disabled - pass with no flags
  if (!gateConfig.enabled) {
    return {
      check: {
        name: "story-size-gate",
        tier: "warning",
        passed: true,
        message: "Story size gate disabled",
      },
      flaggedStories: [],
    };
  }

  const pendingStories = prd.userStories.filter((s) => s.status === "pending");
  const flaggedStories: FlaggedStory[] = [];

  for (const story of pendingStories) {
    const flagged = analyzeStory(story, config);
    if (flagged) {
      flaggedStories.push(flagged);
    }
  }

  // If stories are flagged, return warning (Tier 2, non-blocking)
  if (flaggedStories.length > 0) {
    const storyIds = flaggedStories.map((f) => f.storyId).join(", ");
    return {
      check: {
        name: "story-size-gate",
        tier: "warning",
        passed: false,
        message: `${flaggedStories.length} large stories detected: ${storyIds}`,
      },
      flaggedStories,
    };
  }

  // All stories pass size gate
  return {
    check: {
      name: "story-size-gate",
      tier: "warning",
      passed: true,
      message: `All ${pendingStories.length} pending stories within size limits`,
    },
    flaggedStories: [],
  };
}
