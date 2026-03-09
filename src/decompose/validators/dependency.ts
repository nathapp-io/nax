/**
 * Dependency validator.
 *
 * Validates:
 * - No circular dependencies among substories
 * - All referenced dependency IDs exist (in substories or existing PRD)
 * - No ID collisions with existing PRD story IDs
 */

import type { SubStory, ValidationResult } from "../types";

function detectCycles(substories: SubStory[]): string[] {
  const errors: string[] = [];
  const idSet = new Set(substories.map((s) => s.id));

  // Build adjacency map (only edges within the substory set)
  const adj: Map<string, string[]> = new Map();
  for (const sub of substories) {
    adj.set(
      sub.id,
      sub.dependencies.filter((d) => idSet.has(d)),
    );
  }

  const WHITE = 0; // unvisited
  const GRAY = 1; // in current path
  const BLACK = 2; // done

  const color: Map<string, number> = new Map();
  for (const id of idSet) color.set(id, WHITE);

  const reported = new Set<string>();

  function dfs(id: string, path: string[]): void {
    color.set(id, GRAY);
    for (const dep of adj.get(id) ?? []) {
      if (color.get(dep) === GRAY) {
        // Found a cycle — report it once
        const cycleKey = [...path, dep].sort().join(",");
        if (!reported.has(cycleKey)) {
          reported.add(cycleKey);
          const cycleStart = path.indexOf(dep);
          const cycleNodes = cycleStart >= 0 ? path.slice(cycleStart) : path;
          const cycleStr = [...cycleNodes, dep].join(" -> ");
          errors.push(`Circular dependency detected: ${cycleStr}`);
        }
      } else if (color.get(dep) === WHITE) {
        dfs(dep, [...path, dep]);
      }
    }
    color.set(id, BLACK);
  }

  for (const id of idSet) {
    if (color.get(id) === WHITE) {
      dfs(id, [id]);
    }
  }

  return errors;
}

export function validateDependencies(substories: SubStory[], existingStoryIds: string[]): ValidationResult {
  const errors: string[] = [];

  const substoryIdSet = new Set(substories.map((s) => s.id));
  const existingIdSet = new Set(existingStoryIds);
  const allKnownIds = new Set([...substoryIdSet, ...existingIdSet]);

  // ID collisions with existing PRD
  for (const sub of substories) {
    if (existingIdSet.has(sub.id)) {
      errors.push(`Substory ID "${sub.id}" collides with existing PRD story — duplicate IDs are not allowed`);
    }
  }

  // Non-existent dependency references
  for (const sub of substories) {
    for (const dep of sub.dependencies) {
      if (!allKnownIds.has(dep)) {
        errors.push(`Substory ${sub.id} references non-existent story ID "${dep}"`);
      }
    }
  }

  // Circular dependencies
  const cycleErrors = detectCycles(substories);
  errors.push(...cycleErrors);

  return { valid: errors.length === 0, errors, warnings: [] };
}
