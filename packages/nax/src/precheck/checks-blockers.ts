/**
 * Precheck Tier 1 Blockers
 *
 * Re-exports check implementations from specialized modules.
 */

export { _checkCliDeps as _deps, checkAgentCLI, checkClaudeCLI } from "./checks-cli";

export { checkPRDValid, checkStaleLock } from "./checks-config";
// Re-export for backward compatibility
export {
  checkGitRepoExists,
  checkGitUserConfigured,
  checkWorkingTreeClean,
} from "./checks-git";

export {
  checkCanonicalRulesLint,
  checkDependenciesInstalled,
  checkLintCommand,
  checkTestCommand,
  checkTypecheckCommand,
} from "./checks-system";
