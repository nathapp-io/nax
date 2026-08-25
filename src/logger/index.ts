/**
 * Structured logging module for nax
 *
 * Provides level-gated console output and JSONL file logging for all stages.
 *
 * @module logger
 */

export { formatConsole, formatJsonl } from "./formatters.js";
export { addSink, getLogger, getSafeLogger, initLogger, Logger, resetLogger } from "./logger.js";
export { redactSecrets } from "./redact.js";
export type {
  LogEntry,
  LoggerOptions,
  LogLevel,
  LogSink,
  StoryLogger,
} from "./types.js";
