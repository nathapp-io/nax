/**
 * Precheck implementation functions
 *
 * Re-export barrel for backward compatibility.
 * Tier 1 blockers: ./checks-blockers
 * Tier 2 warnings: ./checks-warnings
 */

// Tier 1 Blockers
export {
  checkGitRepoExists,
  checkWorkingTreeClean,
  checkStaleLock,
  checkPRDValid,
  checkClaudeCLI,
  checkAgentCLI,
  checkDependenciesInstalled,
  checkTestCommand,
  checkLintCommand,
  checkTypecheckCommand,
  checkGitUserConfigured,
} from "./checks-blockers";

// Tier 2 Warnings
export {
  checkClaudeMdExists,
  checkDiskSpace,
  checkPendingStories,
  checkOptionalCommands,
  checkGitignoreCoversNax,
  checkPromptOverrideFiles,
} from "./checks-warnings";
