export type {
  DebateConfig,
  DebateStageConfig,
  ResolverConfig,
  Debater,
  DebateResult,
  ResolverType,
  SessionMode,
} from "../debate/types";
export type {
  NaxConfig,
  Complexity,
  TestStrategy,
  TddStrategy,
  ModelTier,
  ModelDef,
  ModelEntry,
  ModelMap,
  ConfiguredModel,
  ConfiguredModelObject,
  ResolvedConfiguredModel,
  AutoModeConfig,
  ExecutionConfig,
  QualityConfig,
  TddConfig,
  TierConfig,
  RectificationConfig,
  ProjectProfile,
} from "./schema";
export type {
  TestPatternConfig,
  ContextToolRuntimeConfig,
  PromptLoaderConfig,
  LlmRoutingConfig,
  ExecutionGatesConfig,
} from "./selectors";
export {
  DEFAULT_CONFIG,
  resolveConfiguredModel,
  resolveModel,
  resolveModelForAgent,
  NaxConfigSchema,
  AcceptanceConfigSchema,
  PlanConfigSchema,
} from "./schema";
export { ConfiguredModelSchema, ModelTierSchema, TierConfigSchema } from "./schemas-model";
export type { AgentRoutingProfile, AgentRoutingConfig } from "./schemas-infra";
export { AgentRoutingProfileSchema, AgentRoutingConfigSchema } from "./schemas-infra";
export { DebateConfigSchema } from "./schemas-debate";
export { TddConfigSchema } from "./schemas-execution";
export { loadConfig, loadConfigForWorkdir, loadPackageOverride, findProjectDir, globalConfigPath } from "./loader";
export { mergePackageConfig } from "./merge";
export { validateConfig, type ValidationResult } from "./validate"; // @deprecated: Use NaxConfigSchema.safeParse() instead
export { validateDirectory, validateFilePath, isWithinDirectory, MAX_DIRECTORY_DEPTH } from "./path-security";
export { globalConfigDir, projectConfigDir } from "./paths";
export { deepMergeConfig } from "./merger";
export type { PipelineStage } from "./permissions";
export {
  resolveProfileName,
  resolveProfileNames,
  parseProfileList,
  profileOverrideFromConfig,
  loadProfile,
  loadProfileEnv,
  listProfiles,
} from "./profile";
export { pickSelector, reshapeSelector } from "./selector";
export type { ConfigSelector } from "./selector";
export {
  reviewConfigSelector,
  planConfigSelector,
  decomposeConfigSelector,
  rectifyConfigSelector,
  acceptanceConfigSelector,
  acceptanceGenConfigSelector,
  acceptanceFixConfigSelector,
  tddConfigSelector,
  debateConfigSelector,
  routingConfigSelector,
  verifyConfigSelector,
  rectificationGateConfigSelector,
  agentManagerConfigSelector,
  interactionConfigSelector,
  precheckConfigSelector,
  qualityConfigSelector,
  autofixConfigSelector,
  testPatternConfigSelector,
  contextToolRuntimeConfigSelector,
  promptLoaderConfigSelector,
  llmRoutingConfigSelector,
  executionGatesConfigSelector,
} from "./selectors";
export { createConfigLoader } from "./loader-runtime";
export type { ConfigLoader } from "./loader-runtime";
export {
  COMPLEXITY_GUIDE,
  TEST_STRATEGY_GUIDE,
  AC_QUALITY_RULES,
  SPEC_ANCHOR_RULES,
  DESCRIPTION_QUALITY_RULES,
  GROUPING_RULES,
  getAcQualityRules,
  resolveTestStrategy,
  VALID_TEST_STRATEGIES,
  THREE_SESSION_STRATEGIES,
  SINGLE_SESSION_TEST_OWNING_STRATEGIES,
  isThreeSessionStrategy,
  isSingleSessionTestOwningStrategy,
} from "./test-strategy";
