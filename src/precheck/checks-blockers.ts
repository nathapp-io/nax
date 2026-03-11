/**
 * Precheck Tier 1 Blockers
 *
 * Re-exports check implementations from specialized modules.
 */

// Re-export for backward compatibility
export {
  checkGitRepoExists,
  checkWorkingTreeClean,
  checkGitUserConfigured,
} from "./checks-git";

export { checkStaleLock, checkPRDValid } from "./checks-config";

export { checkClaudeCLI, checkAgentCLI, _deps } from "./checks-cli";

export {
  checkDependenciesInstalled,
  checkTestCommand,
  checkLintCommand,
  checkTypecheckCommand,
} from "./checks-system";
