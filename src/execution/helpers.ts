/**
 * Execution Helper Functions
 *
 * Utility functions for execution runner:
 * - Hook context building
 * - Story context extraction
 * - Lock file management
 * - Ready story filtering
 */

import chalk from "chalk";
import path from "node:path";
import type { NgentConfig } from "../config";
import type { PRD, UserStory } from "../prd";
import type { HookContext } from "../hooks";
import { buildContext, formatContextAsMarkdown } from "../context";
import type { StoryContext, ContextBudget } from "../context";

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
export function hookCtx(
  feature: string,
  opts?: Partial<Omit<HookContext, "event" | "feature">>,
): HookContext {
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
  config: NgentConfig,
  useContext: boolean,
): Promise<string | undefined> {
  if (!useContext) {
    return undefined;
  }

  console.log(chalk.dim(`   ⚙️  Building context...`));
  const contextMarkdown = await buildStoryContext(prd, story, config);
  if (contextMarkdown) {
    console.log(chalk.dim(`   ✓ Context built`));
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
export async function buildStoryContext(
  prd: PRD,
  story: UserStory,
  _config: NgentConfig,
): Promise<string | undefined> {
  try {
    const storyContext: StoryContext = {
      prd,
      currentStoryId: story.id,
    };

    const budget: ContextBudget = {
      maxTokens: 100000, // Conservative limit for Claude
      reservedForInstructions: 10000,
      availableForContext: 90000,
    };

    const built = await buildContext(storyContext, budget);

    if (built.elements.length === 0) {
      return undefined;
    }

    return formatContextAsMarkdown(built);
  } catch (error) {
    console.warn(chalk.yellow(`   ⚠️  Context builder failed: ${(error as Error).message}`));
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
  const completedIds = new Set(
    prd.userStories
      .filter((s) => s.passes || s.status === "skipped")
      .map((s) => s.id),
  );

  return prd.userStories.filter(
    (s) =>
      !s.passes &&
      s.status !== "skipped" &&
      s.dependencies.every((dep) => completedIds.has(dep)),
  );
}

/**
 * Acquire execution lock to prevent concurrent runs in same directory.
 * Creates ngent.lock file with PID and timestamp.
 * Returns true if lock acquired, false if another process holds it.
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
  const lockPath = path.join(workdir, "ngent.lock");
  const lockFile = Bun.file(lockPath);

  try {
    const exists = await lockFile.exists();
    if (exists) {
      // Check if lock is stale (> 1 hour old)
      const lockContent = await lockFile.text();
      const lockData = JSON.parse(lockContent);
      const lockAge = Date.now() - lockData.timestamp;
      const ONE_HOUR = 60 * 60 * 1000;

      if (lockAge > ONE_HOUR) {
        console.warn(chalk.yellow(`   ⚠️  Removing stale lock (${Math.round(lockAge / 1000 / 60)} minutes old)`));
        await Bun.spawn(["rm", lockPath], { stdout: "pipe" }).exited;
      } else {
        return false;
      }
    }

    // Create lock file
    const lockData = {
      pid: process.pid,
      timestamp: Date.now(),
    };
    await Bun.write(lockPath, JSON.stringify(lockData));
    return true;
  } catch (error) {
    console.warn(chalk.yellow(`   ⚠️  Failed to acquire lock: ${(error as Error).message}`));
    return false;
  }
}

/**
 * Release execution lock by deleting ngent.lock file.
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
  const lockPath = path.join(workdir, "ngent.lock");
  try {
    const file = Bun.file(lockPath);
    const exists = await file.exists();
    if (exists) {
      await Bun.spawn(["rm", lockPath], { stdout: "pipe" }).exited;
    }
  } catch (error) {
    console.warn(chalk.yellow(`   ⚠️  Failed to release lock: ${(error as Error).message}`));
  }
}
