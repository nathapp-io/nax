/**
 * Execution Helper Functions
 *
 * Re-export barrel for backward compatibility.
 * Story context: ./story-context
 * Lock management: ./lock
 */

/**
 * Error Handling Pattern for Ngent
 *
 * 1. Critical Errors (invalid config, missing required files, security violations):
 *    - Action: throw Error with descriptive message
 *
 * 2. Expected Conditions (no more stories, queue empty, optional feature unavailable):
 *    - Action: return null or undefined
 *
 * 3. Validation Issues (multiple collected errors, partial data problems):
 *    - Action: collect errors in array and return as { errors: string[] }
 *
 * 4. Non-Fatal Warnings (context build failures, optional file missing, rate limit):
 *    - Action: console.warn() + continue execution
 */

// Story context building
export {
  type ExecutionResult,
  hookCtx,
  maybeGetContext,
  buildStoryContext,
  buildStoryContextFull,
  getAllReadyStories,
  type StoryCounts,
  formatProgress,
} from "./story-context";

// Lock management
export { acquireLock, releaseLock } from "./lock";
