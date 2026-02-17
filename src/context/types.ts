/**
 * Context builder types for story-scoped prompt optimization
 */

import type { PRD } from '../prd';

/**
 * Context element that can be included in agent prompts
 */
export interface ContextElement {
  type: 'story' | 'dependency' | 'error' | 'progress' | 'file';
  storyId?: string;
  filePath?: string; // For file context elements
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
 * Story context metadata (PRD + current story)
 */
export interface StoryContext {
  prd: PRD;
  currentStoryId: string;
  workdir?: string; // Optional working directory for resolving relative file paths
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
