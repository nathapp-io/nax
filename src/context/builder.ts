/**
 * Context builder for story-scoped prompt optimization
 *
 * Extracts current story + dependency stories from PRD and builds context within token budget.
 */

import path from "node:path";
import { getLogger } from "../logger";
import { estimateTokens } from "../optimizer/types";
import type { UserStory } from "../prd";
import { countStories, getContextFiles, getExpectedFiles } from "../prd";
import { resolveTestFilePatterns } from "../test-runners/resolver";
import { errorMessage } from "../utils/errors";
import { autoDetectContextFiles } from "./auto-detect";
import {
  createDependencyContext,
  createErrorContext,
  createFileContext,
  createPriorFailuresContext,
  createProgressContext,
  createStoryContext,
  createTestCoverageContext,
} from "./elements";
import { getParentOutputFiles } from "./parent-context";
import { generateTestCoverageSummary } from "./test-scanner";
import type { BuiltContext, ContextBudget, ContextElement, StoryContext } from "./types";

// Dependency injection for testability
export const _contextBuilderDeps = {
  autoDetectContextFiles,
};

/** Max number of explicit context/expected files surfaced into the prompt. */
const FILE_INJECTION_MAX_FILES = 5;
/** Base priority for file-path context elements (decremented per file). */
const FILE_CONTEXT_PRIORITY_BASE = 60;

/** Path-only "read this" hint for an existing reference file. */
function readContextMessage(relativeFilePath: string): string {
  return `_Path: \`${relativeFilePath}\` — read this file before implementing._`;
}

/** Path-only "you will create this" hint for a declared-but-absent output file. */
function createIntentMessage(relativeFilePath: string): string {
  return `_Path: \`${relativeFilePath}\` — this file does not exist yet; you will CREATE it as part of this story._`;
}

// Re-export for backward compatibility
export {
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

  // ENH-006: Inject planning analysis from prd.analysis (priority 88 — above story, below errors)
  if (prd.analysis) {
    const analysisContent = `The following analysis was performed during the planning phase. Use it to understand the codebase context before implementing:\n\n${prd.analysis}`;
    elements.push({
      type: "planning-analysis",
      label: "Planning Analysis",
      content: analysisContent,
      priority: 88,
      tokens: estimateTokens(analysisContent),
    });
  }

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
    // Resolve effective test patterns via SSOT (ADR-009) — replaces deprecated testPattern.
    const resolved = storyContext.config
      ? await resolveTestFilePatterns(storyContext.config, storyContext.workdir)
      : undefined;
    const scanResult = await generateTestCoverageSummary({
      workdir: storyContext.workdir,
      testDir: tcConfig?.testDir,
      resolvedTestGlobs: resolved?.globs,
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
  const fileInjection = storyContext.config?.context?.fileInjection;

  // Explicit contextFiles from the PRD are always honored regardless of fileInjection setting.
  let contextFiles = getContextFiles(story);

  // ENH-005: Inject parent output files for context chaining (always supplementary)
  const parentFiles = getParentOutputFiles(story, storyContext.prd?.userStories ?? []);
  if (parentFiles.length > 0) {
    const logger = getLogger();
    logger.info("context", "Injecting parent output files for context chaining", {
      storyId: story.id,
      parentFiles,
    });
    contextFiles = [...new Set([...contextFiles, ...parentFiles])];
  }

  // Auto-detect only when keyword mode is enabled and no explicit files are provided (BUG-006)
  if (
    contextFiles.length === 0 &&
    fileInjection === "keyword" &&
    storyContext.config?.context?.autoDetect?.enabled !== false &&
    storyContext.workdir
  ) {
    const autoDetectConfig = storyContext.config?.context?.autoDetect;
    const smartRunner = storyContext.config?.execution?.smartTestRunner;
    const testFilePatterns =
      typeof smartRunner === "object" && smartRunner !== null ? smartRunner.testFilePatterns : undefined;
    try {
      const detected = await _contextBuilderDeps.autoDetectContextFiles({
        workdir: storyContext.workdir,
        storyTitle: story.title,
        maxFiles: autoDetectConfig?.maxFiles ?? 5,
        traceImports: autoDetectConfig?.traceImports ?? false,
        testFilePatterns,
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
        error: errorMessage(error),
      });
    }
  }

  const expectedFiles = getExpectedFiles(story);
  if (contextFiles.length === 0 && expectedFiles.length === 0) return;
  const { workdir } = storyContext;
  if (!workdir) {
    getLogger().warn("context", "workdir not set — cannot load context files", { storyId: story.id });
    return;
  }

  const expectedSet = new Set(expectedFiles);
  // Tracks paths already surfaced (read or create-intent) so the expectedFiles
  // recovery pass below does not emit a duplicate element for the same path.
  const surfaced = new Set<string>();
  const filesToLoad = contextFiles.slice(0, FILE_INJECTION_MAX_FILES);

  for (let i = 0; i < filesToLoad.length; i++) {
    const relativeFilePath = filesToLoad[i];
    surfaced.add(relativeFilePath);
    const absolutePath = path.resolve(workdir, relativeFilePath);
    // Always emit path-only — agent reads when needed; avoids token bloat from inlining.
    // Use decreasing priority per index so insertion order is preserved after sort.
    if (await Bun.file(absolutePath).exists()) {
      elements.push(
        createFileContext(relativeFilePath, readContextMessage(relativeFilePath), FILE_CONTEXT_PRIORITY_BASE - i),
      );
      continue;
    }
    // Missing on disk. A file the story CREATES (declared in expectedFiles) is not
    // a hallucinated reference — surface it as create-intent so the path hint is
    // not lost. Genuinely-absent references (not expected) still warn.
    if (expectedSet.has(relativeFilePath)) {
      elements.push(
        createFileContext(relativeFilePath, createIntentMessage(relativeFilePath), FILE_CONTEXT_PRIORITY_BASE - i),
      );
      getLogger().debug("context", "Context file does not exist yet — treated as to-be-created", {
        storyId: story.id,
        filePath: relativeFilePath,
      });
    } else {
      getLogger().warn("context", "Relevant file not found", { filePath: relativeFilePath, storyId: story.id });
    }
  }

  await addCreateIntentElements(elements, workdir, expectedFiles, surfaced);
}

/**
 * Surface declared-but-absent `expectedFiles` as create-intent context so the
 * agent still receives the path hint even when an output file was never listed
 * in (or was mislisted into) `contextFiles`. Files already on disk or already
 * surfaced by the contextFiles pass are skipped.
 */
async function addCreateIntentElements(
  elements: ContextElement[],
  workdir: string,
  expectedFiles: string[],
  surfaced: Set<string>,
): Promise<void> {
  let idx = 0;
  for (const relativeFilePath of expectedFiles.slice(0, FILE_INJECTION_MAX_FILES)) {
    if (surfaced.has(relativeFilePath)) continue;
    const absolutePath = path.resolve(workdir, relativeFilePath);
    if (await Bun.file(absolutePath).exists()) continue;
    elements.push(
      createFileContext(
        relativeFilePath,
        createIntentMessage(relativeFilePath),
        FILE_CONTEXT_PRIORITY_BASE - FILE_INJECTION_MAX_FILES - idx,
      ),
    );
    surfaced.add(relativeFilePath);
    idx++;
  }
}
