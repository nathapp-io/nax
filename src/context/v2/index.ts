/**
 * Context Engine v2 — public barrel
 */

export { ContextOrchestrator, createDefaultOrchestrator, _orchestratorDeps } from "./orchestrator";
export { scoreChunks, scoreChunk, MIN_SCORE } from "./scoring";
export type { ScoredChunk } from "./scoring";
export { dedupeChunks, SIMILARITY_THRESHOLD } from "./dedupe";
export { packChunks } from "./packing";
export type { PackedChunk, PackResult } from "./packing";
export { renderChunks } from "./render";
export { buildDigest, digestTokens } from "./digest";
export { getStageContextConfig, STAGE_CONTEXT_MAP, DEFAULT_STAGE_CONFIG } from "./stage-config";
export type { StageContextConfig } from "./stage-config";
export { StaticRulesProvider, _staticRulesDeps } from "./providers/static-rules";
export { FeatureContextProviderV2, _featureContextV2Deps } from "./providers/feature-context";
export { SessionScratchProvider, _sessionScratchDeps } from "./providers/session-scratch";
export { GitHistoryProvider, _gitHistoryDeps } from "./providers/git-history";
export { CodeNeighborProvider, _codeNeighborDeps } from "./providers/code-neighbor";
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
export type { RunCallCounter } from "./pull-tools";

export type {
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
  ToolDescriptor,
  JSONSchema,
} from "./types";
