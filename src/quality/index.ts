/**
 * Quality Module
 *
 * Shared utilities for running quality commands (lint, typecheck, build, lintFix, etc.)
 */

export type { DefaultQualityCommands } from "./command-defaults";
export {
  _commandDefaultsDeps,
  clearCommandDefaultsCache,
  resolveDefaultQualityCommands,
} from "./command-defaults";
export type { ResolvedTestCommands } from "./command-resolver";
export { _commandResolverDeps, resolveQualityTestCommands } from "./command-resolver";
export type { Diagnostic } from "./diagnostics";
export { detectTool, MAX_RAW_TAIL_CHARS, parseDiagnostics } from "./diagnostics";
export type { QualityCommandOptions, QualityCommandResult } from "./runner";
export { runQualityCommand } from "./runner";
export type {
  PreExistingFailure,
  SelfVerificationPromptInput,
  SelfVerificationResult,
  SelfVerificationStatus,
  SelfVerificationTool,
} from "./self-verification";
export {
  parseSelfVerificationMarker,
  resolveSelfVerificationPromptInput,
} from "./self-verification";
