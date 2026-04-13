/**
 * Rectification Logic
 *
 * Retry logic with backoff, max attempt tracking, and failure categorization.
 * Extracted from execution/rectification.ts to eliminate duplication.
 */

import type { RectificationConfig } from "../config";
import type { RectificationState } from "./types";

/**
 * Determine if rectification should retry based on state and config.
 */
export function shouldRetryRectification(state: RectificationState, config: RectificationConfig): boolean {
  // Stop if max retries reached
  if (state.attempt >= config.maxRetries) {
    return false;
  }

  // #89: Handle unparseable failures (non-zero exit but 0 parsed failures).
  // Treat as infrastructure failure and retry until maxRetries reached.
  if (state.lastExitCode !== undefined && state.lastExitCode !== 0 && state.currentFailures === 0) {
    return true;
  }

  // Stop if all tests passing (and exit code was 0)
  if (state.currentFailures === 0) {
    return false;
  }

  // Abort if failures increased (regression spiral check)
  if (config.abortOnIncreasingFailures && state.currentFailures > state.initialFailures) {
    return false;
  }

  // Continue retrying
  return true;
}

// Re-export types for consumers that import from this module
export type { RectificationState } from "./types";
