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
import {
  createDependencyContext,
  createErrorContext,
  createFileContext,
  createPriorFailuresContext,
  createProgressContext,
  createStoryContext,
  createTestCoverageContext,
  estimateTokens,
} from "./elements";
import { generateTestCoverageSummary } from "./test-scanner";
import type { BuiltContext, ContextBudget, ContextElement, StoryContext } from "./types";

// Dependency injection for testability
export const _deps = {
  autoDetectContextFiles,
};

// Re-export for backward compatibility
export {
  estimateTokens,
  createStoryContext,
  createDependencyContext,
  createErrorContext,
  createProgressContext,
  createFileContext,
  createTestCoverageContext,
  createPriorFailuresContext,
} from "./elements";
export { formatContextAsMarkdown } from "./formatter";

/** Sort context elements by priority (descending) and token count (ascending for same priority) */
export function sortContextElements(elements: ContextElement[]): ContextElement[] {
  return [...elements].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.tokens - b.tokens;
  });
}

/** Generate progress summary */
function generateProgressSummary(prd: StoryContext["prd"]): string {
  const counts = countStories(prd);
  const total = counts.total;
  const complete = counts.passed + counts.failed;
  if (counts.failed > 0) {
    return `Progress: ${complete}/${total} stories complete (${counts.passed} passed, ${counts.failed} failed)`;
  }
  return `Progress: ${complete}/${total} stories complete (${counts.passed} passed)`;
}

/** Generate human-readable summary of built context */
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

/** Build context from PRD + current story within token budget. */
export async function buildContext(storyContext: StoryContext, budget: ContextBudget): Promise<BuiltContext> {
  const { prd, currentStoryId } = storyContext;
  const elements: ContextElement[] = [];

  const currentStory = prd.userStories.find((s) => s.id === currentStoryId);
  if (!currentStory) throw new Error(`Story ${currentStoryId} not found in PRD`);

  // Add progress summary (highest priority)
  elements.push(createProgressContext(generateProgressSummary(prd), 100));

  // Add prior failures (highest priority after progress, priority 95)
  if (
    currentStory.priorFailures &&
    Array.isArray(currentStory.priorFailures) &&
    currentStory.priorFailures.length > 0
  ) {
    elements.push(createPriorFailuresContext(currentStory.priorFailures, 95));
  }

  // Add prior errors (high priority)
  if (currentStory.priorErrors && Array.isArray(currentStory.priorErrors) && currentStory.priorErrors.length > 0) {
    for (const error of currentStory.priorErrors) {
      elements.push(createErrorContext(error, 90));
    }
  }

  // Add current story (high priority)
  elements.push(createStoryContext(currentStory, 80));

  // Add dependency stories (medium priority)
  addDependencyElements(elements, currentStory, prd);

  // Add test coverage summary (priority 85)
  await addTestCoverageElement(elements, storyContext, currentStory);

  // Add relevant source files (priority 60)
  await addFileElements(elements, storyContext, currentStory);

  // Select elements within budget
  const sorted = sortContextElements(elements);
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

  return { elements: selected, totalTokens, truncated, summary: generateSummary(selected, totalTokens, truncated) };
}

/** Add dependency story elements to the context. */
function addDependencyElements(elements: ContextElement[], story: UserStory, prd: StoryContext["prd"]): void {
  if (!story.dependencies || story.dependencies.length === 0) return;
  for (const depId of story.dependencies) {
    const depStory = prd.userStories.find((s) => s.id === depId);
    if (depStory) {
      elements.push(createDependencyContext(depStory, 50));
    } else {
      const logger = getLogger();
      logger.warn("context", "Dependency story not found in PRD", { dependencyId: depId, referencedBy: story.id });
    }
  }
}

/** Add test coverage summary element. */
async function addTestCoverageElement(
  elements: ContextElement[],
  storyContext: StoryContext,
  story: UserStory,
): Promise<void> {
  if (storyContext.config?.context?.testCoverage?.enabled === false || !storyContext.workdir) return;
  try {
    const tcConfig = storyContext.config?.context?.testCoverage;
    const contextFiles = getContextFiles(story);
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

/** Add relevant source file elements (auto-detected or from story config). */
async function addFileElements(
  elements: ContextElement[],
  storyContext: StoryContext,
  story: UserStory,
): Promise<void> {
  const MAX_FILE_SIZE_BYTES = 10 * 1024;
  const MAX_FILES = 5;

  // Skip all file injection when fileInjection is 'disabled' or undefined (treat missing as disabled)
  const fileInjection = storyContext.config?.context?.fileInjection;
  if (fileInjection !== "keyword") return;

  let contextFiles = getContextFiles(story);

  // Auto-detect contextFiles if empty and enabled (BUG-006)
  if (
    contextFiles.length === 0 &&
    storyContext.config?.context?.autoDetect?.enabled !== false &&
    storyContext.workdir
  ) {
    const autoDetectConfig = storyContext.config?.context?.autoDetect;
    try {
      const detected = await _deps.autoDetectContextFiles({
        workdir: storyContext.workdir,
        storyTitle: story.title,
        maxFiles: autoDetectConfig?.maxFiles ?? 5,
        traceImports: autoDetectConfig?.traceImports ?? false,
      });
      if (detected.length > 0) {
        contextFiles = detected;
        const logger = getLogger();
        logger.info("context", "Auto-detected context files", { storyId: story.id, files: detected });
      }
    } catch (error) {
      const logger = getLogger();
      logger.warn("context", "Context auto-detection failed", {
        storyId: story.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (contextFiles.length === 0) return;
  const filesToLoad = contextFiles.slice(0, MAX_FILES);
  const workdir = storyContext.workdir || process.cwd();

  for (const relativeFilePath of filesToLoad) {
    try {
      const absolutePath = path.resolve(workdir, relativeFilePath);
      const file = Bun.file(absolutePath);
      if (!(await file.exists())) {
        const logger = getLogger();
        logger.warn("context", "Relevant file not found", { filePath: relativeFilePath, storyId: story.id });
        continue;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        // FEAT-011: File too large to inline — pass path-only so agent can read it if needed
        const logger = getLogger();
        logger.warn("context", "File too large for inline — using path-only", {
          filePath: relativeFilePath,
          sizeKB: Math.round(file.size / 1024),
          maxKB: 10,
          storyId: story.id,
        });
        elements.push(
          createFileContext(
            relativeFilePath,
            `_File too large to inline (${Math.round(file.size / 1024)}KB). Path: \`${relativeFilePath}\` — read it directly if needed._`,
            5,
          ),
        );
        continue;
      }
      const content = await file.text();
      const ext = path.extname(relativeFilePath).slice(1) || "txt";
      elements.push(
        createFileContext(relativeFilePath, `\`\`\`${ext}\n// File: ${relativeFilePath}\n${content}\n\`\`\``, 60),
      );
    } catch (error) {
      const logger = getLogger();
      logger.warn("context", "Error loading file", {
        filePath: relativeFilePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
