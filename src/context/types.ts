/**
 * Context builder types for story-scoped prompt optimization
 */

/**
 * Context element that can be included in agent prompts
 */
export interface ContextElement {
  type: 'file' | 'config' | 'dependency' | 'error' | 'custom';
  path?: string;
  content: string;
  priority: number; // Higher = more important
  tokens: number; // Estimated token count
}

/**
 * Context budget configuration
 */
export interface ContextBudget {
  maxTokens: number;
  reservedForInstructions: number;
  availableForContext: number;
}

/**
 * Story context metadata
 */
export interface StoryContext {
  storyId: string;
  storyTitle: string;
  relevantFiles: string[];
  dependencies: string[];
  priorErrors?: string[];
  customContext?: string[];
}

/**
 * Built context ready for agent consumption
 */
export interface BuiltContext {
  elements: ContextElement[];
  totalTokens: number;
  truncated: boolean;
  summary: string;
}

/**
 * Context builder configuration
 */
export interface ContextBuilderConfig {
  budget: ContextBudget;
  prioritizeErrors: boolean;
  maxFileSize: number; // Max bytes per file
}
