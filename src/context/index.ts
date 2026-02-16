/**
 * Context builder module for story-scoped prompt optimization
 */

export type {
  ContextElement,
  ContextBudget,
  StoryContext,
  BuiltContext,
  ContextBuilderConfig,
} from './types';

export {
  estimateTokens,
  readFileSafe,
  createFileContext,
  createConfigContext,
  createErrorContext,
  createCustomContext,
  sortContextElements,
  buildContext,
  formatContextAsMarkdown,
} from './builder';
