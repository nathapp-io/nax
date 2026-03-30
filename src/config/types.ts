/**
 * Configuration Type Definitions (Hub)
 *
 * Re-exports all TypeScript interfaces, type aliases, and utility functions
 * for the nax configuration system.
 */

// Schema types
export type {
  Complexity,
  LlmRoutingMode,
  ModelDef,
  ModelEntry,
  ModelMap,
  ModelTier,
  RoutingStrategyName,
  TddStrategy,
  TestStrategy,
  TierConfig,
  TokenPricing,
} from "./schema-types";
export { resolveModel } from "./schema-types";

// Debate types
export type {
  DebateConfig,
  DebateStageConfig,
  ResolverConfig,
  Debater,
  DebateResult,
  ResolverType,
  SessionMode,
} from "../debate/types";

// Runtime types
export type {
  AcceptanceConfig,
  AcceptanceTestStrategy,
  AnalyzeConfig,
  AutoModeConfig,
  ConstitutionConfig,
  ContextAutoDetectConfig,
  ContextConfig,
  DecomposeConfig,
  EscalationEntry,
  ExecutionConfig,
  RawHooksConfig,
  InteractionConfig,
  LlmRoutingConfig,
  NaxConfig,
  OptimizerConfig,
  PlanConfig,
  PluginConfigEntry,
  PrecheckConfig,
  PromptsConfig,
  QualityConfig,
  RectificationConfig,
  RegressionGateConfig,
  ReviewConfig,
  RoutingConfig,
  SmartTestRunnerConfig,
  StorySizeGateConfig,
  TddConfig,
  TestCoverageConfig,
  TestingConfig,
  AdaptiveRoutingConfig,
  AgentConfig,
  ProjectProfile,
} from "./runtime-types";
