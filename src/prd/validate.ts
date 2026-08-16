/**
 * Story ID validation
 *
 * Validates story IDs before they're used in git operations (branch names, worktree paths).
 */

import { NaxError } from "../errors";

/**
 * Validates a story ID for use in git operations.
 *
 * Rejects:
 * - Empty strings
 * - Path traversal attempts (../)
 * - Git flags starting with --
 * - Invalid characters (only allow alphanumeric, dots, hyphens, underscores)
 *
 * Valid pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
 * - Starts with alphanumeric
 * - Contains only alphanumeric, dot, underscore, hyphen
 * - Max 64 characters
 */
export function validateStoryId(id: string): void {
  if (!id || id.length === 0) {
    throw new Error("Story ID cannot be empty");
  }

  // Reject path traversal
  if (id.includes("..")) {
    throw new Error("Story ID cannot contain path traversal (..)");
  }

  // Reject git flags
  if (id.startsWith("--")) {
    throw new Error("Story ID cannot start with git flags (--)");
  }

  // Reject invalid characters - must match pattern
  const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
  if (!validPattern.test(id)) {
    throw new Error(`Story ID must match pattern [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}. Got: ${id}`);
  }
}

/**
 * Rejects a bake-off invocation whose feature `prd.json` is untracked by git
 * or carries uncommitted modifications. Must be called before any worktree
 * is created and before any contestant spend occurs (US-004 AC-1, AC-8, AC-9).
 *
 * STUB (US-004 test-writer session): the real git tracked/clean check is not
 * yet implemented — always throws so callers surface the missing guard.
 */
export async function assertPrdCommitted(prdPath: string, _projectRoot: string): Promise<void> {
  throw new NaxError(`assertPrdCommitted not implemented for ${prdPath}`, "NOT_IMPLEMENTED", {
    stage: "bakeoff-prd-guard",
    prdPath,
  });
}
