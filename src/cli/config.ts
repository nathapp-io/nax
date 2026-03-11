/**
 * Config Command
 *
 * Re-exports config display and loading utilities.
 */

// Display exports
export { configCommand, FIELD_DESCRIPTIONS, type ConfigCommandOptions } from "./config-display";

// Loading exports
export { loadConfigFile, loadGlobalConfig, loadProjectConfig } from "./config-get";

// Diff exports
export { deepDiffConfigs, deepEqual, type ConfigDiff } from "./config-diff";
