/**
 * Context builder for story-scoped prompt optimization
 *
 * Extracts current story + dependency stories from PRD and builds context within token budget.
 */

import path from "node:path";
import type { NaxConfig } from "../config";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { countStories, getContextFiles } from "../prd";
import { autoDetectContextFiles } from "./auto-detect";
import { generateTestCoverageSummary } from "./test-scanner";
import type { BuiltContext, ContextBudget, ContextElement, StoryContext } from "./types";

/**
 * Approximate character-to-token ratio for token estimation.
 *
 * Rationale:
 * - Real tokenization varies by content: "hello" = 1 token, "anthropic" = 2 tokens
 * - English prose: ~4 chars/token (GPT tokenizer standard)
 * - Code/technical text: ~2-3 chars/token (more special chars, symbols)
 * - Value of 3 is a middle ground optimized for mixed content (prose + code + markdown)
 *
 * Accuracy tradeoffs:
 * - ✅ Fast: O(1) calculation, no external dependencies
 * - ✅ Conservative: Slightly overestimates tokens, prevents budget overflow
 * - ❌ Can be off by 20-40% for specific content types
 * - Alternative: Use @anthropic-ai/tokenizer for exact counts (adds dependency)
 *
 * For MVP, this approximation is sufficient. Context budget has safety margins.
 */
const CHARS_PER_TOKEN = 3;

/**
 * Estimate token count for text using character-to-token ratio.
 *
 * Uses rough approximation: 1 token ≈ 3 chars (divide by 3).
 * See CHARS_PER_TOKEN constant for detailed rationale.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Create context element from story
 */
export function createStoryContext(story: UserStory, priority: number): ContextElement {
  const content = formatStoryAsText(story);
  return {
    type: "story",
    storyId: story.id,
    content,
    priority,
    tokens: estimateTokens(content),
  };
}

/**
 * Create context element from dependency story
 */
export function createDependencyContext(story: UserStory, priority: number): ContextElement {
  const content = formatStoryAsText(story);
  return {
    type: "dependency",
    storyId: story.id,
    content,
    priority,
    tokens: estimateTokens(content),
  };
}

/**
 * Create context element from error
 */
export function createErrorContext(errorMessage: string, priority: number): ContextElement {
  return {
    type: "error",
    content: errorMessage,
    priority,
    tokens: estimateTokens(errorMessage),
  };
}

/**
 * Create context element from progress summary
 */
export function createProgressContext(progressText: string, priority: number): ContextElement {
  return {
    type: "progress",
    content: progressText,
    priority,
    tokens: estimateTokens(progressText),
  };
}

/**
 * Create context element from file content
 */
export function createFileContext(filePath: string, content: string, priority: number): ContextElement {
  return {
    type: "file",
    filePath,
    content,
    priority,
    tokens: estimateTokens(content),
  };
}

/**
 * Create context element from test coverage summary
 */
export function createTestCoverageContext(content: string, tokens: number, priority: number): ContextElement {
  return {
    type: "test-coverage",
    content,
    priority,
    tokens,
  };
}

/**
 * Format story as text for context (defensive checks for malformed PRD data)
 */
function formatStoryAsText(story: UserStory): string {
  const parts: string[] = [];

  parts.push(`## ${story.id}: ${story.title}`);
  parts.push("");
  parts.push(`**Description:** ${story.description}`);
  parts.push("");
  parts.push("**Acceptance Criteria:**");

  // Defensive check: handle undefined/null acceptanceCriteria
  if (story.acceptanceCriteria && Array.isArray(story.acceptanceCriteria)) {
    for (const ac of story.acceptanceCriteria) {
      parts.push(`- ${ac}`);
    }
  } else {
    const logger = getLogger();
    logger.warn("context", "Story has invalid acceptanceCriteria", {
      storyId: story.id,
      type: typeof story.acceptanceCriteria,
    });
    parts.push("- (No acceptance criteria defined)");
  }

  if (story.tags && story.tags.length > 0) {
    parts.push("");
    parts.push(`**Tags:** ${story.tags.join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Generate progress summary
 */
function generateProgressSummary(prd: StoryContext["prd"]): string {
  const counts = countStories(prd);
  const total = counts.total;
  const complete = counts.passed + counts.failed;
  const passed = counts.passed;
  const failed = counts.failed;

  if (failed > 0) {
    return `Progress: ${complete}/${total} stories complete (${passed} passed, ${failed} failed)`;
  }

  return `Progress: ${complete}/${total} stories complete (${passed} passed)`;
}

/**
 * Sort context elements by priority (descending) and token count (ascending for same priority)
 */
export function sortContextElements(elements: ContextElement[]): ContextElement[] {
  return [...elements].sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority; // Higher priority first
    }
    return a.tokens - b.tokens; // Smaller token count first (for same priority)
  });
}

/**
 * Build context from PRD + current story within token budget.
 *
 * Prioritizes and selects context elements to fit within available token budget:
 * - Priority 100: Progress summary
 * - Priority 90: Prior errors from current story
 * - Priority 80: Current story (title, description, acceptance criteria)
 * - Priority 50: Dependency stories
 *
 * Elements are sorted by priority and token count. If budget is exceeded,
 * lower-priority elements are dropped and result is marked as truncated.
 *
 * @param storyContext - Story context with PRD and current story ID
 * @param budget - Token budget constraints
 * @returns Built context with selected elements, total tokens, and truncation flag
 *
 * @example
 * ```ts
 * const built = await buildContext(
 *   {
 *     prd: { userStories: [...], ... },
 *     currentStoryId: "US-003",
 *   },
 *   {
 *     totalTokens: 8000,
 *     reservedForPrompt: 2000,
 *     availableForContext: 6000,
 *   }
 * );
 *
 * console.log(built.summary);
 * // "Context: 1 progress, 1 story, 2 dependencies (4200 tokens)"
 *
 * const markdown = formatContextAsMarkdown(built);
 * // Use as agent prompt context
 * ```
 */
export async function buildContext(storyContext: StoryContext, budget: ContextBudget): Promise<BuiltContext> {
  const { prd, currentStoryId } = storyContext;
  const elements: ContextElement[] = [];

  // Find current story
  const currentStory = prd.userStories.find((s) => s.id === currentStoryId);
  if (!currentStory) {
    throw new Error(`Story ${currentStoryId} not found in PRD`);
  }

  // Add progress summary (highest priority)
  const progressText = generateProgressSummary(prd);
  elements.push(createProgressContext(progressText, 100));

  // Add prior errors from current story (high priority)
  // Defensive check: validate priorErrors is an array before iterating
  if (currentStory.priorErrors && Array.isArray(currentStory.priorErrors) && currentStory.priorErrors.length > 0) {
    for (const error of currentStory.priorErrors) {
      elements.push(createErrorContext(error, 90));
    }
  }

  // Add current story (high priority)
  elements.push(createStoryContext(currentStory, 80));

  // Add dependency stories (medium priority)
  if (currentStory.dependencies && currentStory.dependencies.length > 0) {
    for (const depId of currentStory.dependencies) {
      const depStory = prd.userStories.find((s) => s.id === depId);
      if (depStory) {
        elements.push(createDependencyContext(depStory, 50));
      } else {
        // Log warning when dependency story is not found (instead of silently skipping)
        const logger = getLogger();
        logger.warn("context", "Dependency story not found in PRD", {
          dependencyId: depId,
          referencedBy: currentStory.id,
        });
      }
    }
  }

  // Add test coverage summary (priority 85 — below prior errors, above current story)
  if (storyContext.config?.context?.testCoverage?.enabled !== false && storyContext.workdir) {
    try {
      const tcConfig = storyContext.config?.context?.testCoverage;
      const contextFiles = getContextFiles(currentStory);
      const scanResult = await generateTestCoverageSummary({
        workdir: storyContext.workdir,
        testDir: tcConfig?.testDir,
        testPattern: tcConfig?.testPattern,
        maxTokens: tcConfig?.maxTokens ?? 500,
        detail: tcConfig?.detail ?? "names-and-counts",
        contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
        scopeToStory: tcConfig?.scopeToStory ?? true,
      });
      if (scanResult.summary) {
        elements.push(createTestCoverageContext(scanResult.summary, scanResult.tokens, 85));
      }
    } catch (error) {
      const logger = getLogger();
      logger.warn("context", "Test coverage scan failed", { error: (error as Error).message });
    }
  }

  // Add relevant source files (lower priority - priority 60)
  // Load file content from currentStory.contextFiles (or fallback to relevantFiles) if present
  // If empty, auto-detect via git grep (BUG-006)
  // Constraints: max 10KB per file, max 5 files, respect token budget
  const MAX_FILE_SIZE_BYTES = 10 * 1024; // 10KB
  const MAX_FILES = 5;

  let contextFiles = getContextFiles(currentStory);

  // Auto-detect contextFiles if empty and enabled (BUG-006)
  if (
    contextFiles.length === 0 &&
    storyContext.config?.context?.autoDetect?.enabled !== false &&
    storyContext.workdir
  ) {
    const autoDetectConfig = storyContext.config?.context?.autoDetect;
    try {
      const detected = await autoDetectContextFiles({
        workdir: storyContext.workdir,
        storyTitle: currentStory.title,
        maxFiles: autoDetectConfig?.maxFiles ?? 5,
        traceImports: autoDetectConfig?.traceImports ?? false,
      });
      if (detected.length > 0) {
        contextFiles = detected;
        const logger = getLogger();
        logger.info("context", "Auto-detected context files", {
          storyId: currentStory.id,
          files: detected,
        });
      }
    } catch (error) {
      const logger = getLogger();
      logger.warn("context", "Context auto-detection failed", {
        storyId: currentStory.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (contextFiles.length > 0) {
    const filesToLoad = contextFiles.slice(0, MAX_FILES);

    for (const relativeFilePath of filesToLoad) {
      try {
        // Resolve path relative to workdir (passed via storyContext)
        const workdir = storyContext.workdir || process.cwd();
        const absolutePath = path.resolve(workdir, relativeFilePath);

        // Read file
        const file = Bun.file(absolutePath);
        const exists = await file.exists();

        if (!exists) {
          const logger = getLogger();
          logger.warn("context", "Relevant file not found", { filePath: relativeFilePath, storyId: currentStory.id });
          continue;
        }

        const fileSize = file.size;
        if (fileSize > MAX_FILE_SIZE_BYTES) {
          const logger = getLogger();
          logger.warn("context", "File too large", {
            filePath: relativeFilePath,
            sizeKB: Math.round(fileSize / 1024),
            maxKB: 10,
            storyId: currentStory.id,
          });
          continue;
        }

        const content = await file.text();
        const fileContext = `\`\`\`${path.extname(relativeFilePath).slice(1) || "txt"}\n// File: ${relativeFilePath}\n${content}\n\`\`\``;

        elements.push(createFileContext(relativeFilePath, fileContext, 60));
      } catch (error) {
        const logger = getLogger();
        logger.warn("context", "Error loading file", {
          filePath: relativeFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Sort by priority
  const sorted = sortContextElements(elements);

  // Select elements within budget
  const selected: ContextElement[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const element of sorted) {
    if (totalTokens + element.tokens <= budget.availableForContext) {
      selected.push(element);
      totalTokens += element.tokens;
    } else {
      truncated = true;
    }
  }

  // Generate summary
  const summary = generateSummary(selected, totalTokens, truncated);

  return {
    elements: selected,
    totalTokens,
    truncated,
    summary,
  };
}

/**
 * Generate human-readable summary of built context
 */
function generateSummary(elements: ContextElement[], totalTokens: number, truncated: boolean): string {
  const counts: Record<string, number> = {
    story: 0,
    dependency: 0,
    error: 0,
    progress: 0,
    file: 0,
    "test-coverage": 0,
  };

  for (const element of elements) {
    counts[element.type]++;
  }

  const parts: string[] = [];

  if (counts.progress > 0) parts.push(`${counts.progress} progress`);
  if (counts.story > 0) parts.push(`${counts.story} story`);
  if (counts.dependency > 0) parts.push(`${counts.dependency} dependencies`);
  if (counts.error > 0) parts.push(`${counts.error} errors`);
  if (counts.file > 0) parts.push(`${counts.file} files`);
  if (counts["test-coverage"] > 0) parts.push("test coverage");

  const summary = `Context: ${parts.join(", ")} (${totalTokens} tokens)`;

  return truncated ? `${summary} [TRUNCATED]` : summary;
}

/**
 * Format built context as markdown for agent consumption.
 *
 * Generates markdown with sections:
 * - Progress (story completion stats)
 * - Prior Errors (code blocks)
 * - Current Story (title, description, acceptance criteria)
 * - Dependency Stories (if any)
 *
 * @param built - Built context with selected elements
 * @returns Markdown-formatted context string ready for agent prompt
 *
 * @example
 * ```ts
 * const markdown = formatContextAsMarkdown(built);
 * const prompt = `${taskInstructions}\n\n---\n\n${markdown}`;
 * ```
 */
export function formatContextAsMarkdown(built: BuiltContext): string {
  const sections: string[] = [];

  sections.push("# Story Context\n");
  sections.push(`${built.summary}\n`);

  // Group by type
  const byType = new Map<string, ContextElement[]>();

  for (const element of built.elements) {
    const existing = byType.get(element.type) || [];
    existing.push(element);
    byType.set(element.type, existing);
  }

  // Progress first
  if (byType.has("progress")) {
    sections.push("## Progress\n");
    for (const element of byType.get("progress")!) {
      sections.push(element.content);
      sections.push("\n");
    }
  }

  // Errors second (split into ASSET_CHECK and others)
  if (byType.has("error")) {
    const errorElements = byType.get("error")!;
    const assetCheckErrors: ContextElement[] = [];
    const otherErrors: ContextElement[] = [];

    // Separate ASSET_CHECK_FAILED errors from others
    for (const element of errorElements) {
      if (element.content.startsWith("ASSET_CHECK_FAILED:")) {
        assetCheckErrors.push(element);
      } else {
        otherErrors.push(element);
      }
    }

    // Render ASSET_CHECK errors as MANDATORY instructions (highest visibility)
    if (assetCheckErrors.length > 0) {
      sections.push("## ⚠️ MANDATORY: Missing Files from Previous Attempts\n");
      sections.push("**CRITICAL:** Previous attempts failed because these files were not created.\n");
      sections.push("You MUST create these exact files. Do NOT use alternative filenames.\n\n");

      for (const element of assetCheckErrors) {
        // Parse error message to extract file list
        // Format: "ASSET_CHECK_FAILED: Missing files: [file1, file2, ...]\nAction: ..."
        const match = element.content.match(/Missing files: \[([^\]]+)\]/);
        if (match) {
          const fileList = match[1].split(",").map((f) => f.trim());
          sections.push("**Required files:**\n");
          for (const file of fileList) {
            sections.push(`- \`${file}\``);
          }
          sections.push("\n");
        } else {
          // Fallback if parsing fails
          sections.push("```");
          sections.push(element.content);
          sections.push("```\n");
        }
      }
    }

    // Render other errors normally
    if (otherErrors.length > 0) {
      sections.push("## Prior Errors\n");
      for (const element of otherErrors) {
        sections.push("```");
        sections.push(element.content);
        sections.push("```\n");
      }
    }
  }

  // Test coverage (before current story)
  if (byType.has("test-coverage")) {
    for (const element of byType.get("test-coverage")!) {
      sections.push(element.content);
      sections.push("\n");
    }
  }

  // Current story
  if (byType.has("story")) {
    sections.push("## Current Story\n");
    for (const element of byType.get("story")!) {
      sections.push(element.content);
      sections.push("\n");
    }
  }

  // Dependencies
  if (byType.has("dependency")) {
    sections.push("## Dependency Stories\n");
    for (const element of byType.get("dependency")!) {
      sections.push(element.content);
      sections.push("\n");
    }
  }

  // Relevant Files
  if (byType.has("file")) {
    sections.push("## Relevant Source Files\n");
    for (const element of byType.get("file")!) {
      sections.push(element.content);
      sections.push("\n");
    }
  }

  return sections.join("\n");
}
