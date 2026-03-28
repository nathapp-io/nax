/**
 * Conflict Rectification Logic (merged from parallel-executor-rectify.ts)
 *
 * Re-exports all types and functions from the original module.
 * This file is the canonical home for conflict rectification logic (AC-8).
 */

export type {
  ConflictedStoryInfo,
  RectificationResult,
  RectifyConflictedStoryOptions,
} from "./parallel-executor-rectify";

export { rectifyConflictedStory } from "./parallel-executor-rectify";
