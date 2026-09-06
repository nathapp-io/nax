import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { NaxError } from "../errors.js";
import { type FormatterOptions, formatLogEntry, type VerbosityMode } from "../log-format/index.js";
import { stripControlChars } from "../utils/strip-control-chars.js";
import { formatConsole, formatJsonl } from "./formatters.js";
import { redactEntry } from "./redact.js";
import { SinkRegistry } from "./sink-registry.js";
import type { LogEntry, LoggerOptions, LogLevel, LogSink, StoryLogger } from "./types.js";

/**
 * Severity ordering for log levels (lower number = more severe)
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Upper bound on bytes per batched appendFile call.
 *
 * Bounded so a batch stays a small write: crash handlers appendFileSync() fatal
 * entries to the same JSONL file, and a very large append is not atomic.
 */
const MAX_BATCH_BYTES = 64 * 1024;

/**
 * Singleton logger instance
 */
let instance: Logger | null = null;

/**
 * Guards the process-level "exit" listener registration below so repeated
 * initLogger()/resetLogger() cycles (every test file that uses a real
 * logger) don't accumulate one listener per cycle — the listener always
 * reads the live `instance` at actual exit time, so one is sufficient for
 * the process's whole lifetime.
 */
let exitFlushRegistered = false;

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
  private readonly formatterMode?: VerbosityMode;
  private readonly suppressConsole: boolean;
  /** Tail of the async write chain — await this to know all writes have landed */
  private writeQueueTail: Promise<void> = Promise.resolve();
  /** Lines buffered since the last flush task ran — drained as one batched append */
  private readonly pendingLines: string[] = [];
  /** Registered redacted-entry consumers. Order is preserved so dispatch is deterministic. */
  private readonly sinkRegistry = new SinkRegistry();

  /**
   * Stage|message keys already warned about, and how many times each has been
   * seen. Backs {@link warnOnce}; per-instance, so it resets with the run.
   */
  private readonly warnOnceSeen = new Map<string, number>();

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.filePath = options.filePath;
    this.useChalk = options.useChalk ?? true;
    this.formatterMode = options.formatterMode;
    this.suppressConsole = options.suppressConsole ?? false;

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
        mkdirSync(dir, { recursive: true });
      }
    } catch (error) {
      process.stderr.write(`[logger] Failed to create log directory: ${error}\n`);
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
    // Promote sessionRole from data to first-class LogEntry field for parallel log correlation.
    // Callers pass sessionRole in data: { storyId, sessionRole: "reviewer-adversarial", ... }
    let sessionRole: string | undefined;
    let strippedData = data;
    if (data?.sessionRole !== undefined && typeof data.sessionRole === "string") {
      sessionRole = data.sessionRole;
      const { sessionRole: _omit, ...rest } = data;
      strippedData = Object.keys(rest).length > 0 ? rest : undefined;
    }

    const rawEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
      ...(storyId && { storyId }),
      ...(sessionRole && { sessionRole }),
      ...(strippedData && { data: strippedData }),
    };

    // Redact once, up front, so ALL sinks see the sanitized entry. Redacting
    // only on the file path (and only `data`) let secrets interpolated into
    // `message` reach the JSONL log and the terminal in cleartext.
    const entry = redactEntry(rawEntry);

    // Registered sinks inherit secret redaction by construction: they observe
    // the already-redacted entry, never the raw one. Sinks are dispatched
    // independently of console/file gating so a silent-level logger can still
    // ship entries to registered exporters.
    this.sinkRegistry.dispatch(entry);

    const consoleEnabled = this.shouldLog(level) && !this.suppressConsole;
    if (!consoleEnabled && !this.filePath) return;

    // Console output (level-gated, suppressed in TUI mode to avoid corrupting Ink's terminal)
    if (consoleEnabled) {
      let consoleOutput: string | null = null;

      if (this.formatterMode) {
        const formatterOptions: FormatterOptions = {
          mode: this.formatterMode,
          useColor: this.useChalk,
        };
        const formatted = formatLogEntry(entry, formatterOptions);
        if (formatted.shouldDisplay) {
          consoleOutput = formatted.output;
        }
      } else {
        consoleOutput = this.useChalk ? formatConsole(entry) : this.formatPlainConsole(entry);
      }

      if (consoleOutput !== null) {
        console.log(consoleOutput);
      }
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
    // STYLE-21: strip ESC / control bytes from agent- or PRD-controlled
    // display fields before they reach stdout (mirror of formatConsole
    // in src/logger/formatters.ts and the hardened path in
    // src/log-format/formatter.ts:285).
    const parts = [`[${stripControlChars(timestamp)}]`, `[${stripControlChars(entry.stage)}]`];
    if (entry.storyId) {
      parts.push(`[${stripControlChars(entry.storyId)}]`);
    }
    parts.push(stripControlChars(entry.message));
    let output = parts.join(" ");
    if (entry.data && Object.keys(entry.data).length > 0) {
      output += `\n${JSON.stringify(entry.data, null, 2)}`;
    }
    return output;
  }

  /**
   * Append a JSONL line to the log file asynchronously.
   *
   * Lines are buffered and coalesced: a burst of synchronous log() calls enqueues
   * one task each, but the first task to run drains the whole buffer in a single
   * appendFile, and the rest no-op. This collapses N open/write/close syscall
   * triples into one per burst while preserving both write ordering and the
   * flush() contract (callers can await every pending line).
   *
   * The entry is expected to be pre-redacted by log().
   */
  private writeToFile(entry: LogEntry): void {
    if (!this.filePath) return;
    const filePath = this.filePath;
    this.pendingLines.push(`${formatJsonl(entry)}\n`);
    this.writeQueueTail = this.writeQueueTail.then(async () => {
      // Loop, not a single join: crash-writer.ts appendFileSync()s fatal entries to
      // this same file, and a multi-hundred-KB append is not an atomic write — a
      // fatal line could land mid-batch and corrupt the post-mortem log. Capping
      // each append keeps writes small while still collapsing the syscall count.
      while (this.pendingLines.length > 0) {
        let bytes = 0;
        let count = 0;
        while (count < this.pendingLines.length && bytes < MAX_BATCH_BYTES) {
          bytes += this.pendingLines[count].length;
          count++;
        }
        const batch = this.pendingLines.splice(0, count).join("");
        await appendFile(filePath, batch).catch((error) => {
          process.stderr.write(`[logger] Failed to write to log file: ${error}\n`);
        });
      }
    });
  }

  /**
   * Wait for all pending async log writes to complete.
   * Useful in tests that read the log file immediately after writing.
   */
  async flush(): Promise<void> {
    await this.writeQueueTail;
  }

  /**
   * MED-05 — synchronously drain any lines still buffered in `pendingLines`
   * (i.e. not yet claimed by an in-flight async batch) to disk.
   *
   * `process.exit()` terminates before any async work — including the
   * batched `appendFile` in writeToFile() — gets a chance to run, so a run's
   * final log lines (the run.end / fatal-error entries most useful for
   * diagnosing exactly the failure that triggered the exit) were silently
   * lost. `process.on("exit", ...)` listeners may only do synchronous work,
   * so this is a best-effort `appendFileSync` fallback, not a replacement
   * for flush() — callers that can await should still prefer flush().
   */
  flushSync(): void {
    if (!this.filePath || this.pendingLines.length === 0) return;
    const batch = this.pendingLines.splice(0, this.pendingLines.length).join("");
    try {
      appendFileSync(this.filePath, batch);
    } catch (error) {
      process.stderr.write(`[logger] Failed to flush log file on exit: ${error}\n`);
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
   * Warn on the first occurrence of a standing condition; demote the rest.
   *
   * For conditions that are re-evaluated on every agent call and therefore
   * re-emit on every agent call — canonical rules over the static-rules budget,
   * floor chunks over a stage budget. The text never changes, so repeating it
   * costs the operator's attention without informing them: one observed run
   * carried 40 such lines against ~100 lines of real signal.
   *
   * Repeats go to debug with an `occurrence` ordinal rather than being dropped,
   * so the JSONL keeps the full tally for telemetry. The ledger is per Logger
   * instance, which is per run.
   */
  warnOnce(stage: string, message: string, data?: Record<string, unknown>): void {
    const key = `${stage}|${message}`;
    const seen = (this.warnOnceSeen.get(key) ?? 0) + 1;
    this.warnOnceSeen.set(key, seen);

    if (seen === 1) {
      this.warn(stage, message, data);
      return;
    }
    this.debug(stage, message, { ...data, occurrence: seen });
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
   * Register a sink to receive every redacted log entry. Returns an
   * unsubscribe function. Throws from a sink are swallowed by `SinkRegistry`.
   */
  addSink(sink: LogSink): () => void {
    return this.sinkRegistry.add(sink);
  }

  /**
   * Close logger (cleanup method for shutdown).
   *
   * BUG-10 (nax review 20260829): this used to be a no-op on the theory that
   * "Bun handles file operations automatically" — never true; writes go
   * through node:fs/promises appendFile (writeToFile above), not Bun.write.
   * resetLogger() calls close() then nulls the singleton, so whatever sat in
   * pendingLines (buffered lines not yet claimed by an in-flight async batch)
   * was silently dropped. This fires in production, not just tests:
   * bin/nax.ts calls resetLogger() between the plan and run phases of
   * `nax run --plan`, and the exit handler then reads the NEW instance, so
   * the plan-phase JSONL tail was unrecoverable. close() is the method that
   * claims to be cleanup, so it — not just resetLogger() — is the right place
   * to flush; flushSync() is already the correct call (wired to
   * process.on("exit") below).
   */
  close(): void {
    this.flushSync();
  }
}

/**
 * Register a sink on the singleton logger instance.
 *
 * Mirrors the `Logger.addSink` API at the module level so callers can wire
 * exporters without holding a direct `Logger` reference.
 *
 * @throws {NaxError} `LOGGER_NOT_INITIALIZED` if the singleton has not been
 * initialized. A sink registered before `initLogger` cannot fire (the
 * singleton is created with an empty `SinkRegistry`), so silently accepting
 * the registration would orphan it.
 *
 * @returns An unsubscribe function.
 */
export function addSink(sink: LogSink): () => void {
  if (!instance) {
    throw new NaxError("Logger not initialized. Call initLogger() before addSink().", "LOGGER_NOT_INITIALIZED", {
      stage: "logger",
    });
  }
  return instance.addSink(sink);
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
export function initLogger(options: LoggerOptions = { level: "silent" }): Logger {
  if (instance) {
    throw new Error("Logger already initialized. Call getLogger() to access existing instance.");
  }
  instance = new Logger(options);
  // MED-05 — catch-all for every process.exit() call site in the CLI: a
  // synchronous exit-time drain of whatever's still buffered, since none of
  // those call sites can be relied on to individually await flush() first.
  if (options.filePath && !exitFlushRegistered) {
    exitFlushRegistered = true;
    process.on("exit", () => instance?.flushSync());
  }
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
const noopLogger: Logger = new Logger({ level: "silent", useChalk: false, headless: false });

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
    return getLogger();
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
