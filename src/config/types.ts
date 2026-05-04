/**
 * Configuration Type Definitions (Hub)
 *
 * Re-exports all TypeScript interfaces, type aliases, and utility functions
 * for the nax configuration system.
 */

// Schema types
export type {
  Complexity,
  ConfiguredModel,
  ConfiguredModelObject,
  LlmRoutingMode,
  ModelDef,
  ModelEntry,
  ModelMap,
  ModelsConfig,
  ModelTier,
  ResolvedConfiguredModel,
  RoutingStrategyName,
  TddStrategy,
  TestStrategy,
  TierConfig,
  TokenPricing,
} from "./schema-types";
export {
  MODEL_SHORTHAND_TIERS,
  isBuiltinModelTier,
  resolveConfiguredModel,
  resolveModel,
  resolveModelForAgent,
} from "./schema-types";

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
  AcceptanceFixConfig,
  AcceptanceTestStrategy,
  AutoModeConfig,
  ConstitutionConfig,
  ContextAutoDetectConfig,
  ContextConfig,
  ContextV2Config,
  EscalationEntry,
  ExecutionConfig,
  FeatureContextEngineConfig,
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
  AdversarialReviewConfig,
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
  CuratorConfig,
} from "./runtime-types";
