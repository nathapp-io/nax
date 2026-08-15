/**
 * Dependency-cycle detection for PRD user stories (BUG-27).
 *
 * Extracted from schema.ts to stay under the 600-line file limit.
 */

import { NaxError } from "../errors";
import type { UserStory } from "./types";

/**
 * Depth-first cycle detection over the story dependency graph.
 * Returns the cycle as an ordered array of story IDs (first ID repeated at
 * the end) when found, or null when the graph is acyclic. Unknown
 * dependency IDs are ignored here — schema validation already rejects those
 * before this runs.
 */
export function detectDependencyCycle(stories: UserStory[]): string[] | null {
  const depsById = new Map<string, string[]>(stories.map((s) => [s.id, s.dependencies ?? []]));
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  function visit(id: string): string[] | null {
    if (onStack.has(id)) {
      const cycleStart = stack.indexOf(id);
      return [...stack.slice(cycleStart), id];
    }
    if (visited.has(id)) return null;

    visited.add(id);
    onStack.add(id);
    stack.push(id);
    for (const dep of depsById.get(id) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    onStack.delete(id);
    return null;
  }

  for (const story of stories) {
    const found = visit(story.id);
    if (found) return found;
  }
  return null;
}

/** Throws a NaxError naming the cycle when one exists; no-op otherwise. */
export function assertNoDependencyCycle(stories: UserStory[]): void {
  const cycle = detectDependencyCycle(stories);
  if (!cycle) return;
  throw new NaxError(`[schema] Circular dependency detected: ${cycle.join(" -> ")}`, "SCHEMA_VALIDATION_FAILED", {
    stage: "schema",
    cycle,
  });
}
