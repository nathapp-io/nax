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
export {
  DEFAULT_CONFIG,
  resolveConfiguredModel,
  resolveModel,
  resolveModelForAgent,
  NaxConfigSchema,
  AcceptanceConfigSchema,
} from "./schema";
export { loadConfig, findProjectDir, globalConfigPath } from "./loader";
export { validateConfig, type ValidationResult } from "./validate"; // @deprecated: Use NaxConfigSchema.safeParse() instead
export { validateDirectory, validateFilePath, isWithinDirectory, MAX_DIRECTORY_DEPTH } from "./path-security";
export { globalConfigDir, projectConfigDir } from "./paths";
export { deepMergeConfig } from "./merger";
export { resolveProfileName, loadProfile, loadProfileEnv, listProfiles } from "./profile";
