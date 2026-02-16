/**
 * Context builder for story-scoped prompt optimization
 */

import type {
  ContextElement,
  ContextBudget,
  StoryContext,
  BuiltContext,
  ContextBuilderConfig,
} from './types';

/**
 * Estimate token count for text (rough approximation: 1 token ≈ 3 chars)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Read file content safely with size limit
 */
export async function readFileSafe(
  path: string,
  maxSize: number,
): Promise<string | null> {
  try {
    const file = Bun.file(path);
    const size = file.size;

    if (size > maxSize) {
      return `[File too large: ${size} bytes, max ${maxSize}]`;
    }

    return await file.text();
  } catch (error) {
    return null;
  }
}

/**
 * Create context element from file
 */
export async function createFileContext(
  path: string,
  priority: number,
  maxSize: number,
): Promise<ContextElement | null> {
  const content = await readFileSafe(path, maxSize);

  if (!content) {
    return null;
  }

  return {
    type: 'file',
    path,
    content,
    priority,
    tokens: estimateTokens(content),
  };
}

/**
 * Create context element from config
 */
export function createConfigContext(
  configContent: string,
  priority: number,
): ContextElement {
  return {
    type: 'config',
    content: configContent,
    priority,
    tokens: estimateTokens(configContent),
  };
}

/**
 * Create context element from error
 */
export function createErrorContext(
  errorMessage: string,
  priority: number,
): ContextElement {
  return {
    type: 'error',
    content: errorMessage,
    priority,
    tokens: estimateTokens(errorMessage),
  };
}

/**
 * Create context element from custom text
 */
export function createCustomContext(
  content: string,
  priority: number,
): ContextElement {
  return {
    type: 'custom',
    content,
    priority,
    tokens: estimateTokens(content),
  };
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
 * Build context from story metadata within token budget
 */
export async function buildContext(
  story: StoryContext,
  config: ContextBuilderConfig,
): Promise<BuiltContext> {
  const elements: ContextElement[] = [];

  // Add prior errors (highest priority if enabled)
  if (config.prioritizeErrors && story.priorErrors) {
    for (const error of story.priorErrors) {
      elements.push(createErrorContext(error, 100));
    }
  }

  // Add relevant files
  for (const filePath of story.relevantFiles) {
    const fileContext = await createFileContext(
      filePath,
      50, // Medium priority
      config.maxFileSize,
    );
    if (fileContext) {
      elements.push(fileContext);
    }
  }

  // Add custom context
  if (story.customContext) {
    for (const custom of story.customContext) {
      elements.push(createCustomContext(custom, 30));
    }
  }

  // Sort by priority
  const sorted = sortContextElements(elements);

  // Select elements within budget
  const selected: ContextElement[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const element of sorted) {
    if (totalTokens + element.tokens <= config.budget.availableForContext) {
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
    file: 0,
    config: 0,
    error: 0,
    dependency: 0,
    custom: 0,
  };

  for (const element of elements) {
    counts[element.type]++;
  }

  const parts: string[] = [];

  if (counts.file > 0) parts.push(`${counts.file} files`);
  if (counts.error > 0) parts.push(`${counts.error} errors`);
  if (counts.config > 0) parts.push(`${counts.config} configs`);
  if (counts.dependency > 0) parts.push(`${counts.dependency} dependencies`);
  if (counts.custom > 0) parts.push(`${counts.custom} custom`);

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

  // Errors first
  if (byType.has('error')) {
    sections.push('## Prior Errors\n');
    for (const element of byType.get('error')!) {
      sections.push('```');
      sections.push(element.content);
      sections.push('```\n');
    }
  }

  // Files
  if (byType.has('file')) {
    sections.push('## Relevant Files\n');
    for (const element of byType.get('file')!) {
      sections.push(`### ${element.path}\n`);
      sections.push('```');
      sections.push(element.content);
      sections.push('```\n');
    }
  }

  // Config
  if (byType.has('config')) {
    sections.push('## Configuration\n');
    for (const element of byType.get('config')!) {
      sections.push('```json');
      sections.push(element.content);
      sections.push('```\n');
    }
  }

  // Custom
  if (byType.has('custom')) {
    sections.push('## Additional Context\n');
    for (const element of byType.get('custom')!) {
      sections.push(element.content);
      sections.push('\n');
    }
  }

  return sections.join('\n');
}
