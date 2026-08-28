/**
 * Context Engine — public barrel
 */

export {
  CANONICAL_RULES_DIR,
  type CanonicalRule,
  lintForNeutrality,
  loadCanonicalRules,
  NeutralityLintError,
  type NeutralityViolation,
} from "../rules/canonical-loader";
export type { AgentCapabilities, AgentProfile } from "./agent-profiles";
export { AGENT_PROFILES, CONSERVATIVE_DEFAULT_PROFILE, getAgentProfile } from "./agent-profiles";
export type { AgentRenderOptions } from "./agent-renderer";
export { renderForAgent } from "./agent-renderer";
export { estimateAvailableBudgetTokens } from "./available-budget";
export { dedupeChunks, SIMILARITY_THRESHOLD } from "./dedupe";
export type { DiagnosticLike } from "./diagnostic-formatter";
// ENH-5 fix: shared diagnostic-rendering helper extracted from
// ToolDiagnosticsProvider and handleQueryScratch — single source of truth
// for the `file:line:col [tool] (rule) — message` Markdown shape.
export { formatDiagnostic } from "./diagnostic-formatter";
export { buildDigest, DIGEST_RESERVE_TOKENS, digestTokens } from "./digest";
export {
  _effectivenessDeps,
  annotateManifestEffectiveness,
  buildEvidenceTerms,
  type ClassifyScopeOptions,
  classifyWithTerms,
  splitDiffByFile,
} from "./effectiveness";
// STYLE-6 fix: import handleQueryScratch directly from its handler module
// to avoid the circular `pull-tools.ts` ↔ `handlers/query-scratch.ts`
// reference that the previous re-export created.
export { handleQueryScratch } from "./handlers/query-scratch";
export type { ManifestInputs } from "./manifest-builder";
export { buildManifest, CHUNK_SUMMARY_CHARS } from "./manifest-builder";
export type { ManifestPurgeDeps } from "./manifest-purge";
export { _manifestPurgeDeps, MAX_MANIFEST_SCAN, purgeStaleManifests } from "./manifest-purge";
export type { LoadFeatureManifestsOptions, RebuildManifestEntry, StoredContextManifest } from "./manifest-store";
export {
  _manifestStoreDeps,
  contextManifestPath,
  contextStoryDir,
  loadContextManifests,
  loadFeatureManifests,
  rebuildManifestPath,
  writeContextManifest,
  writeRebuildManifest,
} from "./manifest-store";
export { _orchestratorDeps, ContextOrchestrator } from "./orchestrator";
export { createDefaultOrchestrator } from "./orchestrator-factory";
export type { PackedChunk, PackResult } from "./packing";
export { FLOOR_KINDS, packChunks } from "./packing";
export { contextStageForOp } from "./phase-stage-map";
export { deriveProviderWeights } from "./provider-weights";
export { _providerWeightsCacheDeps, ProviderWeightsCache } from "./provider-weights-cache";
export type { ContentCacheState } from "./providers/code-neighbor";
export { _codeNeighborDeps, CodeNeighborProvider, createContentCacheState } from "./providers/code-neighbor";
export type { AssembleCodeNeighborChunkInput, NeighborSection } from "./providers/code-neighbor-chunk";
export { assembleCodeNeighborChunk, contentHash8 } from "./providers/code-neighbor-chunk";
export { _featureContextV2Deps, FeatureContextProviderV2 } from "./providers/feature-context";
export { _gitHistoryDeps, GitHistoryProvider } from "./providers/git-history";
export { _lintConfigProviderDeps, LintConfigProvider } from "./providers/lint-config";
export { _pluginCacheDeps, PluginProviderCache } from "./providers/plugin-cache";
export type { InitialisableProvider } from "./providers/plugin-loader";
export {
  _pluginLoaderDeps,
  loadPluginProviders,
  resolveModuleSpecifier,
} from "./providers/plugin-loader";
export { _priorRunFailureDeps, PriorRunFailureProvider } from "./providers/prior-run-failure";
export { _sessionScratchDeps, SessionScratchProvider } from "./providers/session-scratch";
export {
  _resetCanonicalRulesCache,
  _staticRulesDeps,
  globToRegex,
  normalizePath,
  StaticRulesProvider,
} from "./providers/static-rules";
export { _toolDiagnosticsDeps, ToolDiagnosticsProvider } from "./providers/tool-diagnostics";
export type { PullCallRecord, QueryScratchOptions, RunCallCounter } from "./pull-tools";
export {
  _pullToolsDeps,
  createRunCallCounter,
  DEFAULT_MAX_CALLS_PER_SESSION,
  handleQueryFeatureContext,
  handleQueryNeighbor,
  PULL_TOOL_REGISTRY,
  PullToolBudget,
  QUERY_FEATURE_CONTEXT_DESCRIPTOR,
  QUERY_NEIGHBOR_DESCRIPTOR,
  QUERY_SCRATCH_DESCRIPTOR,
} from "./pull-tools";
export { type RebuildDeps, rebuild } from "./rebuild";
export { FIXED_RENDER_OVERHEAD_TOKENS, renderChunks, separatorOverheadTokens } from "./render";
export type { ScoredChunk } from "./scoring";
export { MIN_SCORE, scoreChunk, scoreChunks } from "./scoring";
export type { StageAssembleOptions } from "./stage-assembler";
export { _stageAssemblerDeps, assembleForStage, getBundleMarkdown } from "./stage-assembler";
export type { StageContextConfig } from "./stage-config";
export { DEFAULT_STAGE_CONFIG, getStageContextConfig, STAGE_CONTEXT_MAP } from "./stage-config";
export type { ContextToolRuntime, SessionToolBudgets } from "./tool-runtime";
export { createContextToolRuntime, createSessionToolBudgets } from "./tool-runtime";
export type {
  AdapterFailure,
  ChunkEffectiveness,
  ChunkKind,
  ChunkRole,
  ChunkScope,
  ContextBundle,
  ContextChunk,
  ContextManifest,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
  JSONSchema,
  ProviderBudgetPressure,
  ProviderScopingReport,
  RawChunk,
  RebuildOptions,
  ToolDescriptor,
} from "./types";
