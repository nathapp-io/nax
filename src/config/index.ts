export type { NaxConfig, Complexity, TestStrategy, ModelTier, ModelDef, ModelEntry, ModelMap, AutoModeConfig, ExecutionConfig, QualityConfig, TddConfig, TierConfig } from "./schema";
export { DEFAULT_CONFIG, resolveModel, NaxConfigSchema } from "./schema";
export { loadConfig, findProjectDir, globalConfigPath } from "./loader";
export { validateConfig, type ValidationResult } from "./validate"; // @deprecated: Use NaxConfigSchema.safeParse() instead
export { validateDirectory, validateFilePath, isWithinDirectory, MAX_DIRECTORY_DEPTH } from "./path-security";
export { globalConfigDir, projectConfigDir } from "./paths";
export { deepMergeConfig } from "./merger";
