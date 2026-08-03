/**
 * Context builder module for story-scoped prompt optimization
 */

export type { ContextElement, ContextBudget, StoryContext, BuiltContext } from "./types";

export { resolveFeatureId, clearFeatureResolverCache, disposeFeatureResolver } from "./feature-resolver";
export {
  filterContextByRole,
  parseAudienceTags,
  shouldIncludeEntry,
  estimateContextTokens,
  truncateToContextBudget,
} from "./feature-context-filter";
export { FeatureContextProvider } from "./providers/feature-context";
export type { FeatureContextResult } from "./providers/feature-context";

export {
  createStoryContext,
  createDependencyContext,
  createErrorContext,
  createProgressContext,
  createFileContext,
  sortContextElements,
  buildContext,
  createTestCoverageContext,
  formatContextAsMarkdown,
} from "./builder";

export { estimateTokens } from "../optimizer/types";
export {
  ContextOrchestrator,
  DIGEST_RESERVE_TOKENS,
  RENDER_OVERHEAD_TOKENS,
  estimateAvailableBudgetTokens,
} from "./engine";
export type { AdapterFailure } from "./engine/types";
export { NeutralityLintError } from "./rules/canonical-loader";

export {
  generateTestCoverageSummary,
  scanTestFiles,
  extractTestStructure,
  formatTestSummary,
  truncateToTokenBudget,
  type TestScanOptions,
  type TestScanResult,
  type TestFileInfo,
  type DescribeBlock,
  type TestSummaryDetail,
} from "./test-scanner";

export { autoDetectContextFiles, extractKeywords, type AutoDetectOptions } from "./auto-detect";

export { isGreenfieldStory } from "./greenfield";
