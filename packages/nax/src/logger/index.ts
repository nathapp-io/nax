/**
 * Structured logging module for nax
 *
 * Provides level-gated console output and JSONL file logging for all stages.
 *
 * @module logger
 */

export { formatConsole, formatJsonl } from "./formatters.js";
export { addSink, getLogger, getSafeLogger, initLogger, Logger, resetLogger } from "./logger.js";
export type { SecretValuePattern } from "./redact.js";
export { redactSecrets, SECRET_VALUE_PATTERNS } from "./redact.js";
export type {
  LogEntry,
  LoggerOptions,
  LogLevel,
  LogSink,
  StoryLogger,
} from "./types.js";
