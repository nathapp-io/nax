/**
 * Structured logging module for nax
 *
 * Provides level-gated console output and JSONL file logging for all stages.
 *
 * @module logger
 */

export type { SecretValuePattern } from "../utils/redact.js";
export { redactSecrets, SECRET_VALUE_PATTERNS } from "../utils/redact.js";
export { formatConsole, formatJsonl } from "./formatters.js";
export { addSink, getLogger, getSafeLogger, initLogger, Logger, resetLogger } from "./logger.js";
export type {
  LogEntry,
  LoggerOptions,
  LogLevel,
  LogSink,
  StoryLogger,
} from "./types.js";
