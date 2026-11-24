/**
 * Quality Module
 *
 * Shared utilities for running quality commands (lint, typecheck, build, test, etc.)
 */

export type { QualityCommandSpec } from "@nathapp/nax-agent/internal";
export {
  commandSpecIncludes,
  containsShellChain,
  normalizeCommandSpec,
  renderCommandSpec,
  replaceInCommandSpec,
} from "@nathapp/nax-agent/internal";
export type { DefaultQualityCommands } from "./command-defaults";
export {
  _commandDefaultsDeps,
  clearCommandDefaultsCache,
  resolveDefaultQualityCommands,
} from "./command-defaults";
export type { PromotedTestCommands, ResolvedTestCommands } from "./command-resolver";
export { _commandResolverDeps, promoteOrchestratorCommand, resolveQualityTestCommands } from "./command-resolver";
export type { Diagnostic } from "./diagnostics";
export { detectTool, MAX_RAW_TAIL_CHARS, parseDiagnostics } from "./diagnostics";
export type { FullSuiteTimeoutConfig } from "./gate-timeout";
export { DEFAULT_FULL_SUITE_TIMEOUT_SECONDS, resolveFullSuiteTimeoutSeconds } from "./gate-timeout";
export { qualityLogsAreQuiet, runQualityQuietly } from "./log-scope";
export type { QualityCommandOptions, QualityCommandResult } from "./runner";
export { runQualityCommand } from "./runner";
/** The detector evidence in words — the same text a stopped run reports (US-008). */
export { stopEvidence } from "./runner-lifecycle";
export type {
  PreExistingFailure,
  SelfVerificationResult,
  SelfVerificationStatus,
  SelfVerificationTool,
} from "./self-verification";
