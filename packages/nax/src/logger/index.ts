/**
 * Structured logging module for nax
 *
 * Provides level-gated console output and JSONL file logging for all stages.
 *
 * @module logger
 */

export type { SecretValuePattern } from "@nathapp/nax-agent/internal";
export { redactSecrets, SECRET_VALUE_PATTERNS } from "@nathapp/nax-agent/internal";
export { formatConsole, formatJsonl } from "./formatters.js";
export { addSink, getLogger, getSafeLogger, initLogger, Logger, resetLogger } from "./logger.js";
export type {
  LogEntry,
  LoggerOptions,
  LogLevel,
  LogSink,
  StoryLogger,
} from "./types.js";
