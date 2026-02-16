/**
 * Context builder for story-scoped prompt optimization
 *
 * Extracts current story + dependency stories from PRD and builds context within token budget.
 */

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
 * Build context from PRD + current story within token budget
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
  };

  for (const element of elements) {
    counts[element.type]++;
  }

  const parts: string[] = [];

  if (counts.progress > 0) parts.push(`${counts.progress} progress`);
  if (counts.story > 0) parts.push(`${counts.story} story`);
  if (counts.dependency > 0) parts.push(`${counts.dependency} dependencies`);
  if (counts.error > 0) parts.push(`${counts.error} errors`);

  const summary = `Context: ${parts.join(', ')} (${totalTokens} tokens)`;

  return truncated ? `${summary} [TRUNCATED]` : summary;
}

/**
 * Format built context as markdown for agent consumption
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

  return sections.join('\n');
}
