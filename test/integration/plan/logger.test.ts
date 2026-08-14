import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fullTest } from "../../helpers/env";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Logger, getLogger, initLogger, resetLogger } from "../../../src/logger";

const TEST_LOG_DIR = path.join(process.cwd(), "test-logs");
const TEST_LOG_FILE = path.join(TEST_LOG_DIR, "test.jsonl");

describe("Logger", () => {
  beforeEach(() => {
    resetLogger();
    // Clean up test logs
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    resetLogger();
    // Clean up test logs
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
  });

  describe("initialization", () => {
    test("creates singleton logger instance", () => {
      const logger = initLogger({ level: "info" });
      expect(logger).toBeInstanceOf(Logger);
      expect(getLogger()).toBe(logger);
    });

    test("throws when initializing twice", () => {
      initLogger({ level: "info" });
      expect(() => initLogger({ level: "info" })).toThrow("Logger already initialized");
    });

    test("returns no-op logger when getting logger before init", () => {
      const logger = getLogger();
      expect(logger).toBeDefined();
      // No-op logger should have all methods but not throw
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.debug).toBe("function");
    });

    test("resets singleton for testing", () => {
      initLogger({ level: "info" });
      resetLogger();
      const logger = getLogger();
      expect(logger).toBeDefined();
      // After reset, should return no-op logger
      expect(typeof logger.info).toBe("function");
    });

    test("creates log file directory if it doesn't exist", () => {
      initLogger({ level: "info", filePath: TEST_LOG_FILE });
      expect(existsSync(TEST_LOG_DIR)).toBe(true);
    });
  });

  describe("level gating (console)", () => {
    test("error level shows only errors", () => {
      const logger = initLogger({ level: "error", useChalk: false });

      // Capture console output
      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      logger.error("test", "error message");
      logger.warn("test", "warn message");
      logger.info("test", "info message");
      logger.debug("test", "debug message");

      console.log = originalLog;

      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("error message");
    });

    test("warn level shows errors and warnings", () => {
      const logger = initLogger({ level: "warn", useChalk: false });

      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      logger.error("test", "error message");
      logger.warn("test", "warn message");
      logger.info("test", "info message");
      logger.debug("test", "debug message");

      console.log = originalLog;

      expect(logs.length).toBe(2);
      expect(logs[0]).toContain("error message");
      expect(logs[1]).toContain("warn message");
    });

    test("info level shows errors, warnings, and info", () => {
      const logger = initLogger({ level: "info", useChalk: false });

      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      logger.error("test", "error message");
      logger.warn("test", "warn message");
      logger.info("test", "info message");
      logger.debug("test", "debug message");

      console.log = originalLog;

      expect(logs.length).toBe(3);
      expect(logs[0]).toContain("error message");
      expect(logs[1]).toContain("warn message");
      expect(logs[2]).toContain("info message");
    });

    test("debug level shows all messages", () => {
      const logger = initLogger({ level: "debug", useChalk: false });

      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      logger.error("test", "error message");
      logger.warn("test", "warn message");
      logger.info("test", "info message");
      logger.debug("test", "debug message");

      console.log = originalLog;

      expect(logs.length).toBe(4);
      expect(logs[0]).toContain("error message");
      expect(logs[1]).toContain("warn message");
      expect(logs[2]).toContain("info message");
      expect(logs[3]).toContain("debug message");
    });
  });

  describe("file output", () => {
    test("writes all log levels to file regardless of console level", async () => {
      // Console level is "error", but file should get all levels
      const logger = initLogger({ level: "error", filePath: TEST_LOG_FILE });

      logger.error("test", "error message");
      logger.warn("test", "warn message");
      logger.info("test", "info message");
      logger.debug("test", "debug message");
      await logger.flush();

      // Read log file
      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line);

      expect(lines.length).toBe(4);

      // Parse each line as JSON and verify
      const entries = lines.map((line) => JSON.parse(line));
      expect(entries[0].level).toBe("error");
      expect(entries[1].level).toBe("warn");
      expect(entries[2].level).toBe("info");
      expect(entries[3].level).toBe("debug");
    });

    test("JSONL lines are valid JSON with required fields", async () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      logger.info("routing", "Task classified", { complexity: "simple" });
      await logger.flush();

      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const line = content.trim();

      // Verify it's valid JSON
      const entry = JSON.parse(line);

      // Verify required fields
      expect(entry.timestamp).toBeDefined();
      expect(typeof entry.timestamp).toBe("string");
      expect(entry.level).toBe("info");
      expect(entry.stage).toBe("routing");
      expect(entry.message).toBe("Task classified");
      expect(entry.data).toEqual({ complexity: "simple" });

      // Verify timestamp is valid ISO format
      expect(() => new Date(entry.timestamp)).not.toThrow();
    });

    test("handles log entries without data field or without storyId", async () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });
      logger.info("test", "message without data");
      logger.info("test", "message without storyId");
      await logger.flush();

      const lines = readFileSync(TEST_LOG_FILE, "utf8").trim().split("\n");
      const [e1, e2] = lines.map((l) => JSON.parse(l));
      expect(e1.data).toBeUndefined();
      expect(e2.storyId).toBeUndefined();
    });

    test("appends to existing log file", async () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      logger.info("test", "first message");
      logger.info("test", "second message");
      await logger.flush();

      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line);

      expect(lines.length).toBe(2);

      const entries = lines.map((line) => JSON.parse(line));
      expect(entries[0].message).toBe("first message");
      expect(entries[1].message).toBe("second message");
    });
  });

  // MED-05: no production caller awaited flush() before process.exit(); a
  // run's final log lines (run.end / fatal-error) were silently lost since
  // process.exit() terminates before the batched async appendFile ran.
  describe("flushSync (MED-05)", () => {
    test("synchronously writes buffered lines to disk without awaiting", () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      logger.info("test", "sync message one");
      logger.info("test", "sync message two");
      logger.flushSync();

      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line);
      expect(lines.length).toBe(2);
      const entries = lines.map((line) => JSON.parse(line));
      expect(entries[0].message).toBe("sync message one");
      expect(entries[1].message).toBe("sync message two");
    });

    test("is a no-op when there is nothing buffered", () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });
      expect(() => logger.flushSync()).not.toThrow();
      expect(existsSync(TEST_LOG_FILE)).toBe(false);
    });

    test("is a no-op when no filePath was configured", () => {
      const logger = initLogger({ level: "info" });
      logger.info("test", "no file configured");
      expect(() => logger.flushSync()).not.toThrow();
    });

    test("registering the process exit listener does not throw across repeated initLogger/resetLogger cycles", () => {
      // Regression for listener accumulation: every test file that calls
      // initLogger() with a filePath must not add a new "exit" listener each
      // time, or a long test run would eventually trip Node's max-listeners
      // warning / leak detector.
      const before = process.listenerCount("exit");
      for (let i = 0; i < 5; i++) {
        resetLogger();
        initLogger({ level: "info", filePath: TEST_LOG_FILE });
      }
      const after = process.listenerCount("exit");
      expect(after).toBe(before);
    });
  });

  describe("withStory", () => {
    test("returns story-scoped logger", () => {
      const logger = initLogger({ level: "info", useChalk: false });
      const storyLogger = logger.withStory("user-auth-001");

      expect(storyLogger).toBeDefined();
      expect(storyLogger.error).toBeInstanceOf(Function);
      expect(storyLogger.warn).toBeInstanceOf(Function);
      expect(storyLogger.info).toBeInstanceOf(Function);
      expect(storyLogger.debug).toBeInstanceOf(Function);
    });

    test("auto-injects storyId into console output", () => {
      const logger = initLogger({ level: "info", useChalk: false });
      const storyLogger = logger.withStory("user-auth-001");

      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      storyLogger.info("agent.start", "Starting agent");

      console.log = originalLog;

      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("[user-auth-001]");
      expect(logs[0]).toContain("Starting agent");
    });

    test("auto-injects storyId into file output", async () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });
      const storyLogger = logger.withStory("user-auth-001");

      storyLogger.info("agent.start", "Starting agent");
      await logger.flush();

      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const entry = JSON.parse(content.trim());

      expect(entry.storyId).toBe("user-auth-001");
      expect(entry.message).toBe("Starting agent");
    });

    test("story logger respects level gating", () => {
      const logger = initLogger({ level: "warn", useChalk: false });
      const storyLogger = logger.withStory("story-123");

      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      storyLogger.debug("test", "debug message");
      storyLogger.info("test", "info message");
      storyLogger.warn("test", "warn message");

      console.log = originalLog;

      // Only warn should be visible
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("warn message");
    });

    test("story logger writes all levels to file", async () => {
      const logger = initLogger({ level: "error", filePath: TEST_LOG_FILE });
      const storyLogger = logger.withStory("story-123");

      storyLogger.error("test", "error");
      storyLogger.warn("test", "warn");
      storyLogger.info("test", "info");
      storyLogger.debug("test", "debug");
      await logger.flush();

      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line);

      expect(lines.length).toBe(4);

      const entries = lines.map((line) => JSON.parse(line));
      entries.forEach((entry) => {
        expect(entry.storyId).toBe("story-123");
      });
    });
  });

  describe("console formatting", () => {
    test("formats console output with timestamp, stage, message, and data as JSON", () => {
      const logger = initLogger({ level: "info", useChalk: false });
      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);
      logger.info("routing", "Task classified");
      logger.info("routing", "Task classified", { complexity: "simple" });
      console.log = originalLog;

      expect(logs[0]).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
      expect(logs[0]).toContain("[routing]");
      expect(logs[0]).toContain("Task classified");
      expect(logs[1]).toContain("complexity");
      expect(logs[1]).toContain("simple");
    });

    test("produces correct format with chalk enabled or disabled", () => {
      for (const useChalk of [true, false]) {
        resetLogger();
        const logger = initLogger({ level: "info", useChalk });
        const originalLog = console.log;
        const logs: string[] = [];
        console.log = (msg: string) => logs.push(msg);
        logger.info("routing", "Task classified");
        console.log = originalLog;
        expect(logs[0], `useChalk=${useChalk}`).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
        expect(logs[0], `useChalk=${useChalk}`).toContain("[routing]");
        expect(logs[0], `useChalk=${useChalk}`).toContain("Task classified");
      }
    });
  });

  describe("data handling", () => {
    test("logs complex data structures and handles empty data object", async () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      logger.info("test", "Complex data", {
        nested: { array: [1, 2, 3], object: { key: "value" } },
        null: null,
        undefined: undefined,
        number: 42,
        boolean: true,
      });
      logger.info("test", "Empty data", {});
      await logger.flush();

      const lines = readFileSync(TEST_LOG_FILE, "utf8").trim().split("\n");
      const [complex, empty] = lines.map((l) => JSON.parse(l));

      expect(complex.data.nested.array).toEqual([1, 2, 3]);
      expect(complex.data.nested.object).toEqual({ key: "value" });
      expect(complex.data.null).toBe(null);
      expect(complex.data.number).toBe(42);
      expect(complex.data.boolean).toBe(true);
      expect(empty.data).toEqual({});
    });
  });

  describe("error handling", () => {
    // Requires non-root env for EACCES — skipped by default, run with FULL=1.
    const skipInCI = fullTest;
    skipInCI("handles file write errors gracefully", () => {
      // Create logger with invalid path
      const originalWrite = process.stderr.write.bind(process.stderr);
      const errors: string[] = [];
      process.stderr.write = ((msg: string) => { errors.push(msg); return true; }) as typeof process.stderr.write;

      const logger = initLogger({
        level: "info",
        filePath: "/invalid/path/test.jsonl",
      });

      logger.info("test", "message");

      process.stderr.write = originalWrite;

      // Should log error to stderr but not crash
      expect(errors.some((e) => e.includes("Failed to write to log file"))).toBe(true);
    });
  });

  describe("close", () => {
    test("close method exists and can be called", () => {
      const logger = initLogger({ level: "info" });

      // Should not throw
      expect(() => logger.close()).not.toThrow();
    });
  });
});
