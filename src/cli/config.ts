/**
 * Config Command
 *
 * Re-exports config display and loading utilities.
 */

// Diff exports
export { type ConfigDiff, deepDiffConfigs, deepEqual } from "./config-diff";
// Display exports
export { type ConfigCommandOptions, configCommand, FIELD_DESCRIPTIONS } from "./config-display";
// Loading exports
export { loadConfigFile, loadGlobalConfig, loadProjectConfig } from "./config-get";

// Profile command exports
export {
  type ProfileShowOptions,
  profileCreateCommand,
  profileCurrentCommand,
  profileListCommand,
  profileShowCommand,
  profileUseCommand,
} from "./config-profile";
