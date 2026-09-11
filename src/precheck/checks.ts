/**
 * Precheck implementation functions
 *
 * Re-export barrel for backward compatibility.
 * Tier 1 blockers: ./checks-blockers
 * Tier 2 warnings: ./checks-warnings
 */

// Agent checks
export { checkMultiAgentHealth } from "./checks-agents";
// Tier 1 Blockers
export {
  checkAgentCLI,
  checkCanonicalRulesLint,
  checkClaudeCLI,
  checkDependenciesInstalled,
  checkGitRepoExists,
  checkGitUserConfigured,
  checkLintCommand,
  checkPRDValid,
  checkStaleLock,
  checkTestCommand,
  checkTypecheckCommand,
  checkWorkingTreeClean,
} from "./checks-blockers";
// Model-resolution precheck (US-1984) — lives in its own module so the
// resolver seam (`_modelResolutionDeps`) can be injected without touching
// checks-blockers, which is a stable Tier-1 barrel.
export {
  _modelResolutionDeps,
  checkModelResolution,
  collectConfiguredModelPins,
  type ModelResolutionDeps,
} from "./checks-model-resolution";
// Tier 2 Warnings
export {
  _checkDiskSpaceDeps,
  checkBuildCommandInReviewChecks,
  checkClaudeMdExists,
  checkDiskSpace,
  checkGitignoreCoversNax,
  checkHomeEnvValid,
  checkLanguageTools,
  checkOptionalCommands,
  checkPendingStories,
  checkPromptOverrideFiles,
  parseDiskSpaceOutput,
} from "./checks-warnings";
