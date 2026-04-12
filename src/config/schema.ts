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
  DebateStageConfig,
  ResolverConfig,
  Debater,
  DebateResult,
  ResolverType,
  SessionMode,
} from "../debate/types";

// Types and resolveModel
export type {
  Complexity,
  ConfiguredModel,
  ConfiguredModelObject,
  TestStrategy,
  TddStrategy,
  EscalationEntry,
  ModelTier,
  TokenPricing,
  ModelDef,
  ModelEntry,
  ModelMap,
  ResolvedConfiguredModel,
  TierConfig,
  AutoModeConfig,
  RectificationConfig,
  RegressionGateConfig,
  ExecutionConfig,
  QualityConfig,
  TddConfig,
  ConstitutionConfig,
  AnalyzeConfig,
  ReviewConfig,
  PlanConfig,
  AcceptanceConfig,
  AcceptanceFixConfig,
  AcceptanceTestStrategy,
  OptimizerConfig,
  PluginConfigEntry,
  RawHooksConfig,
  InteractionConfig,
  TestCoverageConfig,
  ContextAutoDetectConfig,
  ContextConfig,
  RoutingStrategyName,
  AdaptiveRoutingConfig,
  LlmRoutingMode,
  LlmRoutingConfig,
  RoutingConfig,
  StorySizeGateConfig,
  PrecheckConfig,
  SmartTestRunnerConfig,
  NaxConfig,
  AgentConfig,
  ProjectProfile,
} from "./types";

export {
  MODEL_SHORTHAND_TIERS,
  isBuiltinModelTier,
  resolveConfiguredModel,
  resolveModel,
  resolveModelForAgent,
} from "./types";

// Zod schemas
export { NaxConfigSchema, AcceptanceConfigSchema } from "./schemas";

// Default config
export { DEFAULT_CONFIG } from "./defaults";
