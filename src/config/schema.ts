/**
 * Configuration Schema — Re-export Barrel
 *
 * Backward-compatible re-exports from split modules:
 * - types.ts: All TypeScript interfaces, type aliases, resolveModel
 * - schemas.ts: Zod validation schemas
 * - defaults.ts: DEFAULT_CONFIG constant
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
// Default config
export { DEFAULT_CONFIG } from "./defaults";
// Zod schemas
export {
  AcceptanceConfigSchema,
  ContextConfigSchema,
  ContextV2ConfigSchema,
  NaxConfigSchema,
  PlanConfigSchema,
} from "./schemas";
// Types and resolveModel
export type {
  AcceptanceConfig,
  AcceptanceFixConfig,
  AcceptanceTestStrategy,
  AgentConfig,
  AutoModeConfig,
  AutoRouteConfig,
  AutoRouteDowngradeConfig,
  AutoRouteUpgradeConfig,
  Complexity,
  ConfiguredModel,
  ConfiguredModelObject,
  ConstitutionConfig,
  ContextAutoDetectConfig,
  ContextConfig,
  ContextV2Config,
  EscalationEntry,
  ExecutionConfig,
  InteractionConfig,
  LlmRoutingConfig,
  LlmRoutingMode,
  ModelDef,
  ModelEntry,
  ModelMap,
  ModelTier,
  NaxConfig,
  OptimizerConfig,
  PlanConfig,
  PluginConfigEntry,
  PrecheckConfig,
  ProjectProfile,
  QualityConfig,
  RawHooksConfig,
  RectificationConfig,
  RegressionGateConfig,
  ResolvedConfiguredModel,
  ReviewConfig,
  RoutingConfig,
  RoutingStrategyName,
  SmartTestRunnerConfig,
  StorySizeGateConfig,
  TddConfig,
  TddStrategy,
  TestCoverageConfig,
  TestStrategy,
  TierConfig,
  TokenPricing,
} from "./types";
export {
  isBuiltinModelTier,
  isUnrecognizedLiteralModel,
  MODEL_SHORTHAND_TIERS,
  resolveConfiguredModel,
  resolveModel,
  resolveModelForAgent,
  resolveTierMembership,
} from "./types";
