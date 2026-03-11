/**
 * Error utilities
 */

/**
 * Extract error message from unknown error type.
 *
 * Handles both Error instances and non-Error values that can be thrown in JavaScript.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
