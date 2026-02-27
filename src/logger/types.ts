/**
 * Log level type — ordered from most to least severe
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Structured log entry format
 */
export interface LogEntry {
  /** ISO timestamp when log was created */
  timestamp: string;
  /** Severity level */
  level: LogLevel;
  /** Pipeline stage or module name */
  stage: string;
  /** Optional story identifier for context */
  storyId?: string;
  /** Human-readable message */
  message: string;
  /** Optional structured metadata */
  data?: Record<string, unknown>;
}

/**
 * Logger initialization options
 */
export interface LoggerOptions {
  /** Minimum log level for console output (file gets all levels) */
  level: LogLevel;
  /** Optional path to JSONL log file */
  filePath?: string;
  /** Whether to use chalk for console formatting (default: true) */
  useChalk?: boolean;
  /** Formatter verbosity mode for console output (default: uses formatConsole) */
  formatterMode?: "quiet" | "normal" | "verbose" | "json";
  /** Whether running in headless mode (enables formatter) */
  headless?: boolean;
}

/**
 * Story-scoped logger that auto-injects storyId into all log calls
 */
export interface StoryLogger {
  error(stage: string, message: string, data?: Record<string, unknown>): void;
  warn(stage: string, message: string, data?: Record<string, unknown>): void;
  info(stage: string, message: string, data?: Record<string, unknown>): void;
  debug(stage: string, message: string, data?: Record<string, unknown>): void;
}
