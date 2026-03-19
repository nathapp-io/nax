/**
 * Parent output file resolution for context chaining (ENH-005).
 *
 * When a story has dependencies, its parent stories' outputFiles are injected
 * as additional contextFiles so agents have targeted context from prior work.
 */

import type { UserStory } from "../prd/types";

const MAX_PARENT_FILES = 10;

const NOISE_PATTERNS = [
  /\.test\.(ts|js|tsx|jsx)$/,
  /\.spec\.(ts|js|tsx|jsx)$/,
  /package-lock\.json$/,
  /bun\.lockb?$/,
  /\.gitignore$/,
  /^nax\//,
];

/**
 * Get output files from direct parent stories (dependencies[]).
 * Only direct parents — no transitive resolution (keep simple, extend later).
 * Returns deduped list, filtered of noise, capped at MAX_PARENT_FILES.
 */
export function getParentOutputFiles(story: UserStory, allStories: UserStory[]): string[] {
  if (!story.dependencies || story.dependencies.length === 0) return [];

  const parentFiles: string[] = [];
  for (const depId of story.dependencies) {
    const parent = allStories.find((s) => s.id === depId);
    if (parent?.outputFiles) {
      parentFiles.push(...parent.outputFiles);
    }
  }

  const unique = [...new Set(parentFiles)];
  return unique.filter((f) => !NOISE_PATTERNS.some((p) => p.test(f))).slice(0, MAX_PARENT_FILES);
}
