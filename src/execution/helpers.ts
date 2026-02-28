/**
 * Execution Helper Functions
 *
 * Utility functions for execution runner:
 * - Hook context building
 * - Story context extraction
 * - Lock file management
 * - Ready story filtering
 */

import path from "node:path";
import type { NaxConfig } from "../config";
import { buildContext, formatContextAsMarkdown } from "../context";
import type { BuiltContext, ContextBudget, StoryContext } from "../context";
import type { HookContext } from "../hooks";
import { getLogger } from "../logger";
import type { PRD, UserStory } from "../prd";

/**
 * Safely get logger instance, returns null if not initialized
 */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

/**
 * Error Handling Pattern for Ngent
 *
 * Established pattern for consistent error handling across modules:
 *
 * 1. Critical Errors (invalid config, missing required files, security violations):
 *    - Action: throw Error with descriptive message
 *    - Example: Missing PRD file, invalid config schema, path traversal attempt
 *    - Caller: Should catch and abort execution (process.exit(1) at top level)
 *
 * 2. Expected Conditions (no more stories, queue empty, optional feature unavailable):
 *    - Action: return null or undefined
 *    - Example: No next story to execute, queue command not found
 *    - Caller: Should check return value and handle gracefully (skip, continue loop)
 *
 * 3. Validation Issues (multiple collected errors, partial data problems):
 *    - Action: collect errors in array and return as { errors: string[] }
 *    - Example: Dependency validation failures, malformed PRD stories
 *    - Caller: Should display all errors to user, then abort or prompt for fix
 *
 * 4. Non-Fatal Warnings (context build failures, optional file missing, rate limit):
 *    - Action: console.warn() + continue execution
 *    - Example: Dependency story not found in PRD, context truncated, hook timeout
 *    - Caller: No action needed, execution continues with degraded functionality
 *
 * Use this pattern to maintain consistency across all nax modules.
 */

/**
 * Maximum tokens allowed in context budget for Claude agents.
 *
 * Rationale:
 * - Claude has 200k token context window, but we reserve space for:
 *   - System prompt (~5k tokens)
 *   - Agent instructions/prompts (~10k tokens)
 *   - Conversation history (~10k tokens in long sessions)
 *   - Output buffer (~5k tokens)
 * - 100k token limit for story context is conservative but safe
 * - Prevents context overflow that would cause agent failures
 * - Leaves 100k tokens for agent reasoning and responses
 *
 * This limit is used in buildStoryContext() to set ContextBudget.maxTokens.
 */
const CONTEXT_MAX_TOKENS = 100_000;

/**
 * Tokens reserved for agent instructions and prompts.
 *
 * Rationale:
 * - Agent needs space for task instructions, TDD prompts, hook output
 * - Typical instruction template: 2-3k tokens (TDD session, testing requirements)
 * - Hook output (on-story-start, on-error): 1-2k tokens
 * - Story batch prompts (up to 4 stories): 3-5k tokens
 * - 10k token reservation is safe upper bound for all instruction scenarios
 *
 * This is subtracted from CONTEXT_MAX_TOKENS to calculate availableForContext.
 */
const CONTEXT_RESERVED_TOKENS = 10_000;

/** Result from executing a batch or single story */
export interface ExecutionResult {
  success: boolean;
  cost: number;
  storiesProcessed: string[];
}

/**
 * Build a hook context object
 *
 * @param feature - Feature name
 * @param opts - Optional context fields to override
 * @returns Hook context with event set to "on-start" (overridden by fireHook)
 *
 * @example
 * ```typescript
 * const ctx = hookCtx("auth-system", {
 *   storyId: "US-001",
 *   cost: 0.42
 * });
 * ```
 */
export function hookCtx(feature: string, opts?: Partial<Omit<HookContext, "event" | "feature">>): HookContext {
  return {
    event: "on-start", // overridden by fireHook
    feature,
    ...opts,
  };
}

/**
 * Maybe build context if enabled
 *
 * @param prd - PRD to build context from
 * @param story - Current story being executed
 * @param config - Ngent config
 * @param useContext - Whether to build context
 * @returns Context markdown or undefined if disabled/failed
 *
 * @example
 * ```typescript
 * const context = await maybeGetContext(prd, story, config, true);
 * if (context) {
 *   console.log("Using context:", context.length, "chars");
 * }
 * ```
 */
export async function maybeGetContext(
  prd: PRD,
  story: UserStory,
  config: NaxConfig,
  useContext: boolean,
): Promise<string | undefined> {
  if (!useContext) {
    return undefined;
  }

  const logger = getSafeLogger();
  logger?.debug("context", "Building context...");
  const contextMarkdown = await buildStoryContext(prd, story, config);
  if (contextMarkdown) {
    logger?.debug("context", "Context built successfully");
  }
  return contextMarkdown;
}

/**
 * Build story context for context builder
 *
 * @param prd - PRD containing all stories
 * @param story - Current story to build context for
 * @param config - Ngent config
 * @returns Context markdown or undefined if no context available
 *
 * @example
 * ```typescript
 * const context = await buildStoryContext(prd, story, config);
 * if (context) {
 *   // Use context in prompt
 * }
 * ```
 */
export async function buildStoryContext(prd: PRD, story: UserStory, _config: NaxConfig): Promise<string | undefined> {
  try {
    const storyContext: StoryContext = {
      prd,
      currentStoryId: story.id,
      workdir: process.cwd(),
      config: _config,
    };

    const budget: ContextBudget = {
      maxTokens: CONTEXT_MAX_TOKENS,
      reservedForInstructions: CONTEXT_RESERVED_TOKENS,
      availableForContext: CONTEXT_MAX_TOKENS - CONTEXT_RESERVED_TOKENS,
    };

    const built = await buildContext(storyContext, budget);

    if (built.elements.length === 0) {
      return undefined;
    }

    return formatContextAsMarkdown(built);
  } catch (error) {
    const logger = getSafeLogger();
    logger?.warn("context", "Context builder failed", {
      error: (error as Error).message,
    });
    return undefined;
  }
}

/**
 * Build story context returning both markdown and element-level data.
 *
 * Used by `nax prompts` CLI for accurate frontmatter token counts.
 *
 * @param prd - PRD containing all stories
 * @param story - Current story to build context for
 * @param config - Nax config
 * @returns Object with markdown and builtContext, or undefined if no context
 */
export async function buildStoryContextFull(
  prd: PRD,
  story: UserStory,
  config: NaxConfig,
): Promise<{ markdown: string; builtContext: BuiltContext } | undefined> {
  try {
    const storyContext: StoryContext = {
      prd,
      currentStoryId: story.id,
      workdir: process.cwd(),
      config,
    };

    const budget: ContextBudget = {
      maxTokens: CONTEXT_MAX_TOKENS,
      reservedForInstructions: CONTEXT_RESERVED_TOKENS,
      availableForContext: CONTEXT_MAX_TOKENS - CONTEXT_RESERVED_TOKENS,
    };

    const built = await buildContext(storyContext, budget);

    if (built.elements.length === 0) {
      return undefined;
    }

    return { markdown: formatContextAsMarkdown(built), builtContext: built };
  } catch (error) {
    const logger = getSafeLogger();
    logger?.warn("context", "Context builder failed", {
      error: (error as Error).message,
    });
    return undefined;
  }
}

/**
 * Get all stories that are ready to execute (pending, dependencies satisfied)
 *
 * @param prd - PRD containing all stories
 * @returns Array of stories that can be executed now
 *
 * @example
 * ```typescript
 * const readyStories = getAllReadyStories(prd);
 * console.log(`${readyStories.length} stories ready to execute`);
 * ```
 */
export function getAllReadyStories(prd: PRD): UserStory[] {
  const completedIds = new Set(prd.userStories.filter((s) => s.passes || s.status === "skipped").map((s) => s.id));

  return prd.userStories.filter(
    (s) =>
      !s.passes &&
      s.status !== "skipped" &&
      s.status !== "failed" &&
      s.status !== "paused" &&
      s.status !== "blocked" &&
      s.dependencies.every((dep) => completedIds.has(dep)),
  );
}

/**
 * Check if a process with given PID is still alive
 *
 * @param pid - Process ID to check
 * @returns true if process exists and is running
 */
function isProcessAlive(pid: number): boolean {
  try {
    // kill(pid, 0) checks if process exists without actually sending a signal
    // Returns 0 if process exists, throws if not
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire execution lock to prevent concurrent runs in same directory.
 * Creates nax.lock file with PID and timestamp.
 * Returns true if lock acquired, false if another process holds it.
 *
 * Handles stale locks from crashed/OOM-killed processes:
 * - Reads PID from existing lock file
 * - Checks if process is still alive using kill(pid, 0)
 * - Removes stale lock if process is dead
 * - Re-acquires lock after removal
 *
 * @param workdir - Working directory to lock
 * @returns true if lock acquired, false if already locked
 *
 * @example
 * ```typescript
 * const locked = await acquireLock("/path/to/project");
 * if (!locked) {
 *   console.error("Another process is running");
 *   process.exit(1);
 * }
 * ```
 */
export async function acquireLock(workdir: string): Promise<boolean> {
  const lockPath = path.join(workdir, "nax.lock");
  const lockFile = Bun.file(lockPath);

  try {
    // BUG-2 fix: First check for stale lock before attempting atomic create
    const exists = await lockFile.exists();
    if (exists) {
      // Read lock data
      const lockContent = await lockFile.text();
      const lockData = JSON.parse(lockContent);
      const lockPid = lockData.pid;

      // Check if the process is still alive
      if (isProcessAlive(lockPid)) {
        // Process is alive, lock is valid
        return false;
      }

      // Process is dead, remove stale lock
      const logger = getSafeLogger();
      logger?.warn("execution", "Removing stale lock", {
        pid: lockPid,
      });
      const fs = await import("node:fs/promises");
      await fs.unlink(lockPath).catch(() => {});
    }

    // Create lock file atomically using exclusive create (O_CREAT | O_EXCL)
    const lockData = {
      pid: process.pid,
      timestamp: Date.now(),
    };
    const fs = await import("node:fs");
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
    fs.writeSync(fd, JSON.stringify(lockData));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    // EEXIST means another process won the race
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    const logger = getSafeLogger();
    logger?.warn("execution", "Failed to acquire lock", {
      error: (error as Error).message,
    });
    return false;
  }
}

/**
 * Release execution lock by deleting nax.lock file.
 *
 * @param workdir - Working directory to unlock
 *
 * @example
 * ```typescript
 * try {
 *   // ... do work
 * } finally {
 *   await releaseLock("/path/to/project");
 * }
 * ```
 */
export async function releaseLock(workdir: string): Promise<void> {
  const lockPath = path.join(workdir, "nax.lock");
  try {
    const file = Bun.file(lockPath);
    const exists = await file.exists();
    if (exists) {
      const proc = Bun.spawn(["rm", lockPath], { stdout: "pipe" });
      await proc.exited;
      // Wait a bit for filesystem to sync (prevents race in tests)
      await Bun.sleep(10);
    }
  } catch (error) {
    const logger = getSafeLogger();
    logger?.warn("execution", "Failed to release lock", {
      error: (error as Error).message,
    });
  }
}

/** Story counts for progress display */
export interface StoryCounts {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

/**
 * Format a progress line with counts, cost, and ETA
 *
 * @param counts - Story counts (total, passed, failed, pending)
 * @param totalCost - Total cost so far
 * @param costLimit - Cost limit from config
 * @param elapsedMs - Elapsed time in milliseconds
 * @param totalStories - Total number of stories (for ETA calculation)
 * @returns Formatted progress string with emoji indicators
 *
 * @example
 * ```typescript
 * const progress = formatProgress(
 *   { total: 12, passed: 5, failed: 1, pending: 6 },
 *   0.45,
 *   5.0,
 *   600000, // 10 minutes
 *   12
 * );
 * console.log(progress);
 * // 📊 Progress: 6/12 stories | ✅ 5 passed | ❌ 1 failed | 💰 $0.45/$5.00 | ⏱️ ~8 min remaining
 * ```
 */
export function formatProgress(
  counts: StoryCounts,
  totalCost: number,
  costLimit: number,
  elapsedMs: number,
  totalStories: number,
): string {
  const completedStories = counts.passed + counts.failed;
  const remainingStories = totalStories - completedStories;

  // Calculate ETA from average story duration
  let etaText = "calculating...";
  if (completedStories > 0 && remainingStories > 0) {
    const avgDurationPerStory = elapsedMs / completedStories;
    const etaMs = avgDurationPerStory * remainingStories;
    const etaMinutes = Math.round(etaMs / 1000 / 60);
    etaText = `~${etaMinutes} min remaining`;
  } else if (remainingStories === 0) {
    etaText = "complete";
  }

  return `Progress: ${completedStories}/${totalStories} stories | ${counts.passed} passed | ${counts.failed} failed | $${totalCost.toFixed(2)}/$${costLimit.toFixed(2)} | ${etaText}`;
}
