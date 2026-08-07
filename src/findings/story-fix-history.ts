/**
 * Run-scoped story fix history store (US-004).
 *
 * One entry per (storyId, tier) pair, key format `${storyId}::${tier}`. The `tier`
 * segment is `ctx.phaseTelemetry?.tier` so a tier escalation yields a fresh budget
 * — the new model gets a real attempt rather than inheriting the prior model's
 * exhausted budget.
 */

import type { Iteration } from "./cycle-types";
import type { Finding } from "./types";

export interface StoryFixState {
  /** Iterations from every prior cycle for this (story, tier), in completion order. */
  readonly iterations: readonly Iteration<Finding>[];
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
  let existing = store.get(key);
  if (!existing) {
    existing = { iterations: [], declines: new Map<string, Set<string>>() };
    store.set(key, existing);
  }
  return existing;
}

export function appendStoryFixIterations(
  store: StoryFixHistory,
  key: string,
  iterations: readonly Iteration<Finding>[],
): void {
  const existing = store.get(key);
  if (existing) {
    store.set(key, {
      iterations: [...existing.iterations, ...iterations],
      declines: existing.declines,
    });
  } else {
    store.set(key, {
      iterations: [...iterations],
      declines: new Map<string, Set<string>>(),
    });
  }
}

/**
 * Merge a cycle-local decline snapshot back into the store, alongside the
 * iteration append at the same call site — so a mid-cycle throw (which skips
 * both persist calls) never leaves the decline ledger updated while the
 * iteration history is not (US-003).
 */
export function mergeStoryFixDeclines(
  store: StoryFixHistory,
  key: string,
  declines: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const existing = store.get(key);
  store.set(key, {
    iterations: existing?.iterations ?? [],
    declines: new Map([...declines].map(([name, keys]) => [name, new Set(keys)])),
  });
}
