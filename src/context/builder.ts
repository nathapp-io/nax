/**
 * Context builder for story-scoped prompt optimization
 *
 * Extracts current story + dependency stories from PRD and builds context within token budget.
 */

import path from 'node:path';
import type { ContextElement, ContextBudget, StoryContext, BuiltContext } from './types';
import type { UserStory } from '../prd';
import { countStories } from '../prd';

/**
 * Estimate token count for text.
 *
 * Uses rough approximation: 1 token ≈ 3 chars (divide by 3).
 *
 * Rationale:
 * - Real tokenization varies by content: "hello" = 1 token, "anthropic" = 2 tokens
 * - English prose: ~4 chars/token (GPT tokenizer standard)
 * - Code/technical text: ~2-3 chars/token (more special chars, symbols)
 * - Our formula (divide by 3) is a middle ground optimized for mixed content
 *
 * Accuracy tradeoffs:
 * - ✅ Fast: O(1) calculation, no external dependencies
 * - ✅ Conservative: Slightly overestimates tokens, prevents budget overflow
 * - ❌ Can be off by 20-40% for specific content types
 * - Alternative: Use @anthropic-ai/tokenizer for exact counts (adds dependency)
 *
 * For MVP, this approximation is sufficient. Context budget has safety margins.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Create context element from story
 */
export function createStoryContext(story: UserStory, priority: number): ContextElement {
  const content = formatStoryAsText(story);
  return {
    type: 'story',
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
    type: 'dependency',
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
    type: 'error',
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
    type: 'progress',
    content: progressText,
    priority,
    tokens: estimateTokens(progressText),
  };
}

/**
 * Create context element from file content
 */
export function createFileContext(
  filePath: string,
  content: string,
  priority: number,
): ContextElement {
  return {
    type: 'file',
    filePath,
    content,
    priority,
    tokens: estimateTokens(content),
  };
}

/**
 * Format story as text for context (defensive checks for malformed PRD data)
 */
function formatStoryAsText(story: UserStory): string {
  const parts: string[] = [];

  parts.push(`## ${story.id}: ${story.title}`);
  parts.push('');
  parts.push(`**Description:** ${story.description}`);
  parts.push('');
  parts.push('**Acceptance Criteria:**');

  // Defensive check: handle undefined/null acceptanceCriteria
  if (story.acceptanceCriteria && Array.isArray(story.acceptanceCriteria)) {
    for (const ac of story.acceptanceCriteria) {
      parts.push(`- ${ac}`);
    }
  } else {
    console.warn(`⚠️  Story ${story.id} has invalid acceptanceCriteria (expected array, got ${typeof story.acceptanceCriteria})`);
    parts.push('- (No acceptance criteria defined)');
  }

  if (story.tags && story.tags.length > 0) {
    parts.push('');
    parts.push(`**Tags:** ${story.tags.join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * Generate progress summary
 */
function generateProgressSummary(prd: StoryContext['prd']): string {
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
export async function buildContext(
  storyContext: StoryContext,
  budget: ContextBudget,
): Promise<BuiltContext> {
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
        console.warn(`⚠️  Dependency story ${depId} not found in PRD (referenced by ${currentStory.id})`);
      }
    }
  }

  // Add relevant source files (lower priority - priority 60)
  // Load file content from currentStory.relevantFiles if present
  // Constraints: max 10KB per file, max 5 files, respect token budget
  const MAX_FILE_SIZE_BYTES = 10 * 1024; // 10KB
  const MAX_FILES = 5;

  if (currentStory.relevantFiles && Array.isArray(currentStory.relevantFiles) && currentStory.relevantFiles.length > 0) {
    const filesToLoad = currentStory.relevantFiles.slice(0, MAX_FILES);

    for (const relativeFilePath of filesToLoad) {
      try {
        // Resolve path relative to workdir (passed via storyContext)
        const workdir = storyContext.workdir || process.cwd();
        const absolutePath = path.resolve(workdir, relativeFilePath);

        // Read file
        const file = Bun.file(absolutePath);
        const exists = await file.exists();

        if (!exists) {
          console.warn(`⚠️  Relevant file not found: ${relativeFilePath} (story: ${currentStory.id})`);
          continue;
        }

        const fileSize = file.size;
        if (fileSize > MAX_FILE_SIZE_BYTES) {
          console.warn(`⚠️  File too large (${Math.round(fileSize / 1024)}KB > 10KB): ${relativeFilePath} (story: ${currentStory.id})`);
          continue;
        }

        const content = await file.text();
        const fileContext = `\`\`\`${path.extname(relativeFilePath).slice(1) || 'txt'}\n// File: ${relativeFilePath}\n${content}\n\`\`\``;

        elements.push(createFileContext(relativeFilePath, fileContext, 60));
      } catch (error) {
        console.warn(`⚠️  Error loading file ${relativeFilePath}: ${error instanceof Error ? error.message : String(error)}`);
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
function generateSummary(
  elements: ContextElement[],
  totalTokens: number,
  truncated: boolean,
): string {
  const counts = {
    story: 0,
    dependency: 0,
    error: 0,
    progress: 0,
    file: 0,
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

  const summary = `Context: ${parts.join(', ')} (${totalTokens} tokens)`;

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

  sections.push('# Story Context\n');
  sections.push(`${built.summary}\n`);

  // Group by type
  const byType = new Map<string, ContextElement[]>();

  for (const element of built.elements) {
    const existing = byType.get(element.type) || [];
    existing.push(element);
    byType.set(element.type, existing);
  }

  // Progress first
  if (byType.has('progress')) {
    sections.push('## Progress\n');
    for (const element of byType.get('progress')!) {
      sections.push(element.content);
      sections.push('\n');
    }
  }

  // Errors second
  if (byType.has('error')) {
    sections.push('## Prior Errors\n');
    for (const element of byType.get('error')!) {
      sections.push('```');
      sections.push(element.content);
      sections.push('```\n');
    }
  }

  // Current story
  if (byType.has('story')) {
    sections.push('## Current Story\n');
    for (const element of byType.get('story')!) {
      sections.push(element.content);
      sections.push('\n');
    }
  }

  // Dependencies
  if (byType.has('dependency')) {
    sections.push('## Dependency Stories\n');
    for (const element of byType.get('dependency')!) {
      sections.push(element.content);
      sections.push('\n');
    }
  }

  // Relevant Files
  if (byType.has('file')) {
    sections.push('## Relevant Source Files\n');
    for (const element of byType.get('file')!) {
      sections.push(element.content);
      sections.push('\n');
    }
  }

  return sections.join('\n');
}
