/**
 * Configuration Schema — Re-export Barrel
 *
 * Backward-compatible re-exports from split modules:
 * - types.ts: All TypeScript interfaces, type aliases, resolveModel
 * - schemas.ts: Zod validation schemas
 * - defaults.ts: DEFAULT_CONFIG constant
 */

// Types and resolveModel
export type {
  Complexity,
  TestStrategy,
  TddStrategy,
  EscalationEntry,
  ModelTier,
  TokenPricing,
  ModelDef,
  ModelEntry,
  ModelMap,
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
  AcceptanceTestStrategy,
  OptimizerConfig,
  PluginConfigEntry,
  HooksConfig,
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
  DecomposeConfig,
  NaxConfig,
} from "./types";

export { resolveModel } from "./types";

// Zod schemas
export { NaxConfigSchema, AcceptanceConfigSchema } from "./schemas";

// Default config
export { DEFAULT_CONFIG } from "./defaults";
