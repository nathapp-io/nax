/**
 * story.start announcement — the human-readable log line emitted when a story
 * is dispatched.
 *
 * Extracted from the executor so the three dispatch paths (parallel batch,
 * single-story batch fallback, sequential) share one shape. Callers must emit
 * this only AFTER `preIterationTierCheck` has cleared the attempt to run
 * (#1653): before that point the attempt may still be refused for an exhausted
 * tier ladder, and a story.start line for it reads as a fresh attempt the agent
 * abandoned instantly.
 *
 * The `story:started` bus event is deliberately NOT emitted here — it stays at
 * the pre-check call sites, because tier-escalation's BUG-5 branch pairs it with
 * a compensating `story:failed`, and reporters, the events file, the TUI, and
 * the max-retries trigger all depend on that pairing.
 */

import { DEFAULT_CONFIG, type ModelTier, type NaxConfig, resolveModelForAgent } from "../config";
import { getSafeLogger } from "../logger";
import type { PRD, UserStory } from "../prd/types";

/** Tier/agent/complexity the story will actually run as, resolved by the caller. */
export interface StoryStartAnnouncement {
  complexity: string;
  modelTier: string;
  agent: string;
  /** The model id the tier resolves to for `agent`, when it could be resolved (nax#2491 P6). */
  model?: string;
}

/** The model id `tier` resolves to for `agent` (default-agent fallback, as dispatch does), or undefined. */
export function storyModelName(
  config: NaxConfig,
  agent: string,
  tier: string,
  defaultAgent: string,
): string | undefined {
  try {
    return resolveModelForAgent(config.models ?? DEFAULT_CONFIG.models, agent, tier as ModelTier, defaultAgent).model;
  } catch {
    return undefined;
  }
}

/**
 * A story's number is its ordinal in the PRD, not a progress counter (#1653).
 * The previous derivation (`total - pending + 1`) moved as *other* stories
 * finished, so the same story was logged under a different number on each
 * attempt. Returns 0 for a story absent from the PRD — defensive only; every
 * dispatch path selects from `prd.userStories`.
 */
export function storyOrdinal(prd: PRD, storyId: string): number {
  return prd.userStories.findIndex((s) => s.id === storyId) + 1;
}

/** `{ model }` for a StoryStartAnnouncement, or `{}` when the tier cannot be resolved. */
export function announcedModel(
  config: NaxConfig,
  agent: string,
  tier: string,
  defaultAgent: string | undefined,
): { model?: string } {
  const model = storyModelName(config, agent, tier, defaultAgent ?? agent);
  return model !== undefined ? { model } : {};
}

/** Emit the `story.start` log line for a story that is about to be dispatched. */
export function logStoryStart(prd: PRD, story: UserStory, announcement: StoryStartAnnouncement): void {
  getSafeLogger()?.info("story.start", `${story.title}`, {
    storyId: story.id,
    storyTitle: story.title,
    complexity: announcement.complexity,
    modelTier: announcement.modelTier,
    agent: announcement.agent,
    ...(announcement.model !== undefined ? { model: announcement.model } : {}),
    storyNumber: storyOrdinal(prd, story.id),
    storyTotal: prd.userStories.length,
    attempt: story.attempts + 1,
  });
}
