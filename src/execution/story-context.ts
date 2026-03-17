/**
 * Story Context Building
 *
 * Extracted from helpers.ts: context building and story readiness functions.
 */

import type { NaxConfig } from "../config";
import { buildContext, formatContextAsMarkdown } from "../context";
import type { BuiltContext, ContextBudget, StoryContext } from "../context";
import type { HookContext } from "../hooks";
import { getLogger } from "../logger";
import type { PRD, UserStory } from "../prd";

/** Safely get logger instance, returns null if not initialized */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

/**
 * Maximum tokens allowed in context budget for Claude agents.
 *
 * Claude has 200k token context window, but we reserve space for system prompt,
 * agent instructions, conversation history, and output buffer. 100k token limit
 * for story context is conservative but safe, leaving 100k tokens for agent
 * reasoning and responses.
 */
const CONTEXT_MAX_TOKENS = 100_000;

/**
 * Tokens reserved for agent instructions and prompts.
 *
 * Agent needs space for task instructions, TDD prompts, hook output.
 * 10k token reservation is safe upper bound for all instruction scenarios.
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
 * Load package-level context.md content if it exists.
 *
 * Reads <packageWorkdir>/nax/context.md and returns its content, or null
 * if the file does not exist.
 *
 * @internal
 */
async function loadPackageContextMd(packageWorkdir: string): Promise<string | null> {
  const contextPath = `${packageWorkdir}/nax/context.md`;
  const file = Bun.file(contextPath);
  if (!(await file.exists())) return null;
  return file.text();
}

/**
 * Build story context returning both markdown and element-level data.
 * Used by `nax prompts` CLI for accurate frontmatter token counts.
 *
 * When `packageWorkdir` is provided (absolute path of story.workdir),
 * appends the package-level nax/context.md after the root context.
 */
export async function buildStoryContextFull(
  prd: PRD,
  story: UserStory,
  config: NaxConfig,
  packageWorkdir?: string,
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

    // MW-003: append package-level context.md if workdir is set
    let packageSection = "";
    if (packageWorkdir) {
      const pkgContent = await loadPackageContextMd(packageWorkdir);
      if (pkgContent) {
        packageSection = `\n---\n\n${pkgContent.trim()}`;
      }
    }

    if (built.elements.length === 0 && !packageSection) {
      return undefined;
    }

    const baseMarkdown = built.elements.length > 0 ? formatContextAsMarkdown(built) : "";
    const markdown = packageSection ? `${baseMarkdown}${packageSection}` : baseMarkdown;

    return { markdown, builtContext: built };
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
 */
export function getAllReadyStories(prd: PRD): UserStory[] {
  const completedIds = new Set(prd.userStories.filter((s) => s.passes || s.status === "skipped").map((s) => s.id));

  const logger = getSafeLogger();
  logger?.debug("routing", "getAllReadyStories: completed set", {
    completedIds: [...completedIds],
    totalStories: prd.userStories.length,
  });

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
 * @returns Formatted progress string
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
