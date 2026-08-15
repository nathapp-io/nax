/**
 * Context Engine — public barrel
 */

export { ContextOrchestrator, _orchestratorDeps } from "./orchestrator";
export { createDefaultOrchestrator } from "./orchestrator-factory";
export type { RebuildOptions } from "./types";
export { scoreChunks, scoreChunk, MIN_SCORE } from "./scoring";
export type { ScoredChunk } from "./scoring";
export { dedupeChunks, SIMILARITY_THRESHOLD } from "./dedupe";
export { FLOOR_KINDS, packChunks } from "./packing";
export type { PackedChunk, PackResult } from "./packing";
export { buildManifest, CHUNK_SUMMARY_CHARS } from "./manifest-builder";
export type { ManifestInputs } from "./manifest-builder";
export { renderChunks, separatorOverheadTokens, FIXED_RENDER_OVERHEAD_TOKENS } from "./render";
export { buildDigest, DIGEST_RESERVE_TOKENS, digestTokens } from "./digest";
export { rebuild, type RebuildDeps } from "./rebuild";
export { estimateAvailableBudgetTokens } from "./available-budget";
export { getStageContextConfig, STAGE_CONTEXT_MAP, DEFAULT_STAGE_CONFIG } from "./stage-config";
export type { StageContextConfig } from "./stage-config";
export { StaticRulesProvider, _staticRulesDeps, globToRegex, normalizePath } from "./providers/static-rules";
export { FeatureContextProviderV2, _featureContextV2Deps } from "./providers/feature-context";
export { SessionScratchProvider, _sessionScratchDeps } from "./providers/session-scratch";
export { ToolDiagnosticsProvider, _toolDiagnosticsDeps } from "./providers/tool-diagnostics";
export { PriorRunFailureProvider, _priorRunFailureDeps } from "./providers/prior-run-failure";
export { LintConfigProvider, _lintConfigProviderDeps } from "./providers/lint-config";
export { GitHistoryProvider, _gitHistoryDeps } from "./providers/git-history";
export { CodeNeighborProvider, _codeNeighborDeps, createContentCacheState } from "./providers/code-neighbor";
export type { ContentCacheState } from "./providers/code-neighbor";
export { assembleCodeNeighborChunk, contentHash8 } from "./providers/code-neighbor-chunk";
export type { NeighborSection, AssembleCodeNeighborChunkInput } from "./providers/code-neighbor-chunk";
export {
  loadPluginProviders,
  resolveModuleSpecifier,
  _pluginLoaderDeps,
} from "./providers/plugin-loader";
export type { InitialisableProvider } from "./providers/plugin-loader";
export { PluginProviderCache, _pluginCacheDeps } from "./providers/plugin-cache";
export { ProviderWeightsCache, _providerWeightsCacheDeps } from "./provider-weights-cache";
export {
  loadCanonicalRules,
  lintForNeutrality,
  NeutralityLintError,
  CANONICAL_RULES_DIR,
  type CanonicalRule,
  type NeutralityViolation,
} from "../rules/canonical-loader";
export {
  QUERY_NEIGHBOR_DESCRIPTOR,
  QUERY_FEATURE_CONTEXT_DESCRIPTOR,
  PULL_TOOL_REGISTRY,
  PullToolBudget,
  createRunCallCounter,
  handleQueryNeighbor,
  handleQueryFeatureContext,
} from "./pull-tools";
export type { PullCallRecord, RunCallCounter } from "./pull-tools";

export { getAgentProfile, AGENT_PROFILES, CONSERVATIVE_DEFAULT_PROFILE } from "./agent-profiles";
export type { AgentCapabilities, AgentProfile } from "./agent-profiles";
export { renderForAgent } from "./agent-renderer";
export type { AgentRenderOptions } from "./agent-renderer";

export { assembleForStage, getBundleMarkdown, _stageAssemblerDeps } from "./stage-assembler";
export type { StageAssembleOptions } from "./stage-assembler";
export { createContextToolRuntime, createSessionToolBudgets } from "./tool-runtime";
export type { ContextToolRuntime, SessionToolBudgets } from "./tool-runtime";
export {
  _manifestStoreDeps,
  writeContextManifest,
  writeRebuildManifest,
  loadContextManifests,
  loadFeatureManifests,
  contextManifestPath,
  contextStoryDir,
  rebuildManifestPath,
} from "./manifest-store";
export type { StoredContextManifest, RebuildManifestEntry, LoadFeatureManifestsOptions } from "./manifest-store";

export {
  _effectivenessDeps,
  annotateManifestEffectiveness,
  buildEvidenceTerms,
  classifyWithTerms,
  splitDiffByFile,
  type ClassifyScopeOptions,
} from "./effectiveness";

export { purgeStaleManifests, _manifestPurgeDeps, MAX_MANIFEST_SCAN } from "./manifest-purge";
export type { ManifestPurgeDeps } from "./manifest-purge";

export { deriveProviderWeights } from "./provider-weights";

export type {
  AdapterFailure,
  ChunkEffectiveness,
  ChunkKind,
  ChunkScope,
  ChunkRole,
  ContextChunk,
  ContextManifest,
  ContextBundle,
  ContextRequest,
  RawChunk,
  ContextProviderResult,
  IContextProvider,
  ProviderBudgetPressure,
  ProviderScopingReport,
  ToolDescriptor,
  JSONSchema,
} from "./types";
