import { appendFileSync } from "node:fs";
import { formatConsole, formatJsonl } from "./formatters.js";
import type { LogEntry, LogLevel, LoggerOptions, StoryLogger } from "./types.js";

/**
 * Severity ordering for log levels (lower number = more severe)
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Singleton logger instance
 */
let instance: Logger | null = null;

/**
 * Structured logger with level gating and dual output (console + JSONL file)
 *
 * @example
 * ```typescript
 * // Initialize logger (usually in CLI entry point)
 * initLogger({ level: "info", filePath: "nax/features/auth/runs/run-123.jsonl" });
 *
 * // Use logger throughout application
 * const logger = getLogger();
 * logger.info("routing", "Task classified", { complexity: "simple" });
 *
 * // Story-scoped logger
 * const storyLogger = logger.withStory("user-auth-001");
 * storyLogger.info("agent.start", "Starting agent session");
 * ```
 */
export class Logger {
  private readonly level: LogLevel;
  private readonly filePath?: string;
  private readonly useChalk: boolean;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.filePath = options.filePath;
    this.useChalk = options.useChalk ?? true;

    // Ensure parent directory exists if file path provided
    if (this.filePath) {
      this.initFileDirectory();
    }
  }

  /**
   * Create parent directory for log file if it doesn't exist
   */
  private initFileDirectory(): void {
    if (!this.filePath) return;

    try {
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
      if (dir) {
        Bun.spawnSync(["mkdir", "-p", dir]);
      }
    } catch (error) {
      console.error(`[logger] Failed to create log directory: ${error}`);
    }
  }

  /**
   * Check if a log level should be displayed on console
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[this.level];
  }

  /**
   * Internal log method — writes to console (if level permits) and file (always)
   */
  private log(level: LogLevel, stage: string, message: string, data?: Record<string, unknown>, storyId?: string): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
      ...(storyId && { storyId }),
      ...(data && { data }),
    };

    // Console output (level-gated)
    if (this.shouldLog(level)) {
      const consoleOutput = this.useChalk ? formatConsole(entry) : this.formatPlainConsole(entry);
      console.log(consoleOutput);
    }

    // File output (always write all levels)
    if (this.filePath) {
      this.writeToFile(entry);
    }
  }

  /**
   * Plain console format (no chalk) — used when useChalk is false
   */
  private formatPlainConsole(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toLocaleTimeString("en-US", {
      hour12: false,
    });
    const parts = [`[${timestamp}]`, `[${entry.stage}]`];
    if (entry.storyId) {
      parts.push(`[${entry.storyId}]`);
    }
    parts.push(entry.message);
    let output = parts.join(" ");
    if (entry.data && Object.keys(entry.data).length > 0) {
      output += `\n${JSON.stringify(entry.data, null, 2)}`;
    }
    return output;
  }

  /**
   * Write JSONL line to file (synchronous append)
   */
  private writeToFile(entry: LogEntry): void {
    if (!this.filePath) return;

    try {
      const line = `${formatJsonl(entry)}\n`;
      // Use Node.js fs for simple synchronous append
      appendFileSync(this.filePath, line, "utf8");
    } catch (error) {
      console.error(`[logger] Failed to write to log file: ${error}`);
    }
  }

  /**
   * Log an error message
   */
  error(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log("error", stage, message, data);
  }

  /**
   * Log a warning message
   */
  warn(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log("warn", stage, message, data);
  }

  /**
   * Log an info message
   */
  info(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log("info", stage, message, data);
  }

  /**
   * Log a debug message
   */
  debug(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log("debug", stage, message, data);
  }

  /**
   * Create a story-scoped logger that auto-injects storyId
   *
   * @param storyId - Story identifier to inject into all log calls
   * @returns StoryLogger instance
   *
   * @example
   * ```typescript
   * const logger = getLogger();
   * const storyLogger = logger.withStory("user-auth-001");
   * storyLogger.info("agent.start", "Starting agent"); // storyId auto-added
   * ```
   */
  withStory(storyId: string): StoryLogger {
    return {
      error: (stage: string, message: string, data?: Record<string, unknown>) =>
        this.log("error", stage, message, data, storyId),
      warn: (stage: string, message: string, data?: Record<string, unknown>) =>
        this.log("warn", stage, message, data, storyId),
      info: (stage: string, message: string, data?: Record<string, unknown>) =>
        this.log("info", stage, message, data, storyId),
      debug: (stage: string, message: string, data?: Record<string, unknown>) =>
        this.log("debug", stage, message, data, storyId),
    };
  }

  /**
   * Close logger (cleanup method for shutdown)
   * Note: Bun.write handles file operations automatically, no manual cleanup needed
   */
  close(): void {
    // No-op: Bun handles file operations internally
  }
}

/**
 * Initialize the singleton logger instance
 *
 * @param options - Logger configuration options
 * @throws Error if logger is already initialized
 *
 * @example
 * ```typescript
 * initLogger({
 *   level: "info",
 *   filePath: "nax/features/auth/runs/2026-02-20T10-30-00Z.jsonl"
 * });
 * ```
 */
export function initLogger(options: LoggerOptions): Logger {
  if (instance) {
    throw new Error("Logger already initialized. Call getLogger() to access existing instance.");
  }
  instance = new Logger(options);
  return instance;
}

/**
 * Get the singleton logger instance
 *
 * @throws Error if logger has not been initialized
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const logger = getLogger();
 * logger.info("routing", "Task classified");
 * ```
 */
/**
 * No-op logger for tests/environments where logger isn't initialized
 */
const noopLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  withStory: () => noopLogger,
} as any;

export function getLogger(): Logger {
  if (!instance) {
    return noopLogger;
  }
  return instance;
}

/**
 * Safely get logger instance, returns null if not initialized
 *
 * @returns Logger instance or null if not initialized
 *
 * @example
 * ```typescript
 * const logger = getSafeLogger();
 * logger?.info("routing", "Task classified");
 * ```
 */
export function getSafeLogger(): Logger | null {
  try {
    const logger = getLogger();
    return logger === noopLogger ? null : logger;
  } catch {
    return null;
  }
}

/**
 * Reset logger singleton (for testing only)
 * @internal
 */
export function resetLogger(): void {
  if (instance) {
    instance.close();
  }
  instance = null;
}
