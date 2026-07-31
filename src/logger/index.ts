/**
 * Structured logging module for nax
 *
 * Provides level-gated console output and JSONL file logging for all stages.
 *
 * @module logger
 */

export { Logger, initLogger, getLogger, getSafeLogger, resetLogger, addSink } from "./logger.js";
export { formatConsole, formatJsonl } from "./formatters.js";
export type {
  LogLevel,
  LogEntry,
  LogSink,
  LoggerOptions,
  StoryLogger,
} from "./types.js";
