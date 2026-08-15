/**
 * Quality Module
 *
 * Shared utilities for running quality commands (lint, typecheck, build, lintFix, etc.)
 */

export { runQualityCommand } from "./runner";
export type { QualityCommandOptions, QualityCommandResult } from "./runner";
export { resolveQualityTestCommands, _commandResolverDeps } from "./command-resolver";
export type { ResolvedTestCommands } from "./command-resolver";
export {
  resolveDefaultQualityCommands,
  clearCommandDefaultsCache,
  _commandDefaultsDeps,
} from "./command-defaults";
export type { DefaultQualityCommands } from "./command-defaults";
export {
  parseSelfVerificationMarker,
  resolveSelfVerificationPromptInput,
} from "./self-verification";
export type {
  PreExistingFailure,
  SelfVerificationPromptInput,
  SelfVerificationResult,
  SelfVerificationStatus,
  SelfVerificationTool,
} from "./self-verification";
export { parseDiagnostics, detectTool, MAX_RAW_TAIL_CHARS } from "./diagnostics";
export type { Diagnostic } from "./diagnostics";
