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
  _orchestratorDeps,
  DIGEST_RESERVE_TOKENS,
  FIXED_RENDER_OVERHEAD_TOKENS,
  estimateAvailableBudgetTokens,
} from "./engine";
export type { AdapterFailure, ContextBundle, ContextChunk } from "./engine/types";
export type { PackedChunk } from "./engine/packing";
export { NeutralityLintError } from "./rules/canonical-loader";
export { splitRuleIntoSections } from "./rules/rule-sections";
export type { RuleSection } from "./rules/rule-sections";
export { applySectionBudget } from "./rules/rule-budget";
export type { SectionBudgetResult } from "./rules/rule-budget";

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
export {
  writeFragment,
  readFragment,
  listFragmentStoryIds,
  deleteFragment,
  fragmentPath,
  truncateToFragmentBudget,
  _fragmentStoreDeps,
} from "./fragments";
