/**
 * Run-scoped story fix history store (US-004).
 *
 * A per-story store of completed fix-cycle iterations and declined findings,
 * carried on `NaxRuntime.storyFixHistory` across rectification re-entry.
 *
 * The entry key used to be `${storyId}::${tier}::${agent}` — an escalation rung
 * rather than a tier, so an escalated agent got a fresh budget instead of
 * inheriting the prior rung's exhausted counters (#1530). The key builder and
 * the iteration/decline writers went with the fix cycle (B2b-3); what remains
 * is the store's shape and its constructor, which `createRuntime` still calls.
 */

import type { Iteration } from "./cycle-types";
import type { Finding } from "./types";

export interface StoryFixState {
  /** Iterations from every prior cycle for this story's rung, in completion order. */
  readonly iterations: readonly Iteration<Finding>[];
  /** Backing store for the decline ledger: strategy name -> declined finding key set. */
  readonly declines: Map<string, Set<string>>;
}

export type StoryFixHistory = Map<string, StoryFixState>;

export function createStoryFixHistory(): StoryFixHistory {
  return new Map<string, StoryFixState>();
}
