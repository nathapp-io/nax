/**
 * Context builder module for story-scoped prompt optimization
 */

export type { ContextElement, ContextBudget, StoryContext, BuiltContext } from './types';

export {
  estimateTokens,
  createStoryContext,
  createDependencyContext,
  createErrorContext,
  createProgressContext,
  sortContextElements,
  buildContext,
  formatContextAsMarkdown,
} from './builder';
