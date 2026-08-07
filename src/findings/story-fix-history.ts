/**
 * Run-scoped story fix history store (US-004 carrier; consumption lands in US-002/US-003).
 *
 * One entry per (storyId, tier) pair, key format `${storyId}::${tier}`. The `tier`
 * segment is `ctx.phaseTelemetry?.tier` so a tier escalation yields a fresh budget
 * — the new model gets a real attempt rather than inheriting the prior model's
 * exhausted budget.
 *
 * US-004 test-writer stubs. The store types are complete; the runtime functions
 * are deliberately minimal so the AC-covering tests fail at the assertion (proving
 * the behaviour is missing) rather than at import. The implementer in the next
 * session replaces the placeholder bodies with real logic.
 */

import type { Iteration } from "./cycle-types";
import type { Finding } from "./types";

export interface StoryFixState {
  /** Iterations from every prior cycle for this (story, tier), in completion order. */
  readonly iterations: Iteration<Finding>[];
  /** Backing store for the decline ledger: strategy name -> declined findingKey set. */
  readonly declines: Map<string, Set<string>>;
}

export type StoryFixHistory = Map<string, StoryFixState>;

export function createStoryFixHistory(): StoryFixHistory {
  return new Map<string, StoryFixState>();
}

export function storyFixKey(storyId: string, tier?: string): string {
  return `${storyId}::${tier ?? "default"}`;
}

export function getStoryFixState(store: StoryFixHistory, key: string): StoryFixState {
  const existing = store.get(key);
  if (existing) return existing;
  return { iterations: [{} as Iteration<Finding>], declines: new Map<string, Set<string>>() };
}

export function appendStoryFixIterations(
  store: StoryFixHistory,
  key: string,
  iterations: readonly Iteration<Finding>[],
): void {
  const existing = store.get(key);
  if (existing) {
    store.set(key, {
      iterations: existing.iterations,
      declines: existing.declines,
    });
  }
}
