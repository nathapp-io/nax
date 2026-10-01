/**
 * Test File Classifier
 *
 * Converts a `ResolvedTestPatterns` struct into a fast sync predicate
 * `(path: string) => boolean` for hot-path classification.
 *
 * Pattern (resolve once per story, classify many):
 *
 *   const resolved = await resolveTestFilePatterns(config, workdir);
 *   const isTest = createTestFileClassifier(resolved);
 *   const testFiles = changedFiles.filter(isTest);
 */

import type { ResolvedTestPatterns } from "./resolver";

/**
 * Build a sync `(path) => boolean` classifier from resolved test patterns.
 *
 * Returns a function that always returns `false` when the resolved pattern
 * list is empty (explicit `testFilePatterns: []` in config).
 *
 * The classifier uses the pre-built `regex` artefact from `ResolvedTestPatterns`
 * so no per-call regex compilation occurs.
 */
export function createTestFileClassifier(resolved: ResolvedTestPatterns): (path: string) => boolean {
  const { regex } = resolved;
  if (regex.length === 0) return () => false;
  return (path: string) => regex.some((re) => re.test(path));
}
