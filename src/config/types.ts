/**
 * Configuration Type Definitions (Hub)
 *
 * Re-exports all TypeScript interfaces, type aliases, and utility functions
 * for the nax configuration system.
 */

// Debate types
export type {
  DebateConfig,
  DebateResult,
  Debater,
  DebateStageConfig,
  ResolverConfig,
  ResolverType,
  SessionMode,
} from "../debate/types";
// Runtime types
export type {
  AcceptanceConfig,
  AcceptanceFixConfig,
  AcceptanceTestStrategy,
  AdversarialReviewConfig,
  AgentConfig,
  AutoModeConfig,
  ConstitutionConfig,
  ContextAutoDetectConfig,
  ContextConfig,
  ContextV2Config,
  CuratorConfig,
  EscalationEntry,
  ExecutionConfig,
  FeatureContextEngineConfig,
  FinishTimeoutsConfig,
  IdleWatchdogConfig,
  InteractionConfig,
  LlmRoutingConfig,
  NaxConfig,
  OptimizerConfig,
  PlanConfig,
  PluginConfigEntry,
  PrecheckConfig,
  ProjectProfile,
  PromptsConfig,
  QualityConfig,
  RawHooksConfig,
  RectificationConfig,
  RegressionGateConfig,
  ReviewConfig,
  RoutingConfig,
  SmartTestRunnerConfig,
  StorySizeGateConfig,
  TddConfig,
  TestCoverageConfig,
  TestingConfig,
} from "./runtime-types";
export type { AutoRouteConfig, AutoRouteDowngradeConfig, AutoRouteUpgradeConfig } from "./runtime-types-auto-route";
// Schema types
export type {
  Complexity,
  ComplexityRung,
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
  isBuiltinModelTier,
  isUnrecognizedLiteralModel,
  MODEL_SHORTHAND_TIERS,
  resolveConfiguredModel,
  resolveModel,
  resolveModelForAgent,
  resolveTierMembership,
} from "./schema-types";
