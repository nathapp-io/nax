import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Logger, getLogger, initLogger, resetLogger } from "../../src/logger/logger.js";

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
    test("writes all log levels to file regardless of console level", () => {
      // Console level is "error", but file should get all levels
      const logger = initLogger({ level: "error", filePath: TEST_LOG_FILE });

      logger.error("test", "error message");
      logger.warn("test", "warn message");
      logger.info("test", "info message");
      logger.debug("test", "debug message");

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

    test("JSONL lines are valid JSON with required fields", () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      logger.info("routing", "Task classified", { complexity: "simple" });

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

    test("handles log entries without data field", () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      logger.info("test", "message without data");

      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const entry = JSON.parse(content.trim());

      expect(entry.data).toBeUndefined();
    });

    test("handles log entries without storyId", () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      logger.info("test", "message without storyId");

      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const entry = JSON.parse(content.trim());

      expect(entry.storyId).toBeUndefined();
    });

    test("appends to existing log file", () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      logger.info("test", "first message");
      logger.info("test", "second message");

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

    test("auto-injects storyId into file output", () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });
      const storyLogger = logger.withStory("user-auth-001");

      storyLogger.info("agent.start", "Starting agent");

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

    test("story logger writes all levels to file", () => {
      const logger = initLogger({ level: "error", filePath: TEST_LOG_FILE });
      const storyLogger = logger.withStory("story-123");

      storyLogger.error("test", "error");
      storyLogger.warn("test", "warn");
      storyLogger.info("test", "info");
      storyLogger.debug("test", "debug");

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
    test("formats console output with timestamp, stage, and message", () => {
      const logger = initLogger({ level: "info", useChalk: false });

      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      logger.info("routing", "Task classified");

      console.log = originalLog;

      expect(logs[0]).toMatch(/\[\d{2}:\d{2}:\d{2}\]/); // timestamp
      expect(logs[0]).toContain("[routing]"); // stage
      expect(logs[0]).toContain("Task classified"); // message
    });

    test("formats console output with data as pretty JSON", () => {
      const logger = initLogger({ level: "info", useChalk: false });

      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      logger.info("routing", "Task classified", { complexity: "simple" });

      console.log = originalLog;

      expect(logs[0]).toContain("complexity");
      expect(logs[0]).toContain("simple");
    });

    test("supports chalk formatting when enabled", () => {
      const logger = initLogger({ level: "info", useChalk: true });

      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      logger.info("routing", "Task classified");

      console.log = originalLog;

      // Should contain basic formatting (timestamp, stage, message)
      expect(logs[0]).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
      expect(logs[0]).toContain("[routing]");
      expect(logs[0]).toContain("Task classified");
    });

    test("disables chalk formatting when useChalk is false", () => {
      const logger = initLogger({ level: "info", useChalk: false });

      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (msg: string) => logs.push(msg);

      logger.info("routing", "Task classified");

      console.log = originalLog;

      // Should contain basic formatting (timestamp, stage, message)
      expect(logs[0]).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
      expect(logs[0]).toContain("[routing]");
      expect(logs[0]).toContain("Task classified");
    });
  });

  describe("data handling", () => {
    test("logs complex data structures", () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      const complexData = {
        nested: {
          array: [1, 2, 3],
          object: { key: "value" },
        },
        null: null,
        undefined: undefined,
        number: 42,
        boolean: true,
      };

      logger.info("test", "Complex data", complexData);

      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const entry = JSON.parse(content.trim());

      expect(entry.data.nested.array).toEqual([1, 2, 3]);
      expect(entry.data.nested.object).toEqual({ key: "value" });
      expect(entry.data.null).toBe(null);
      expect(entry.data.number).toBe(42);
      expect(entry.data.boolean).toBe(true);
    });

    test("handles empty data object", () => {
      const logger = initLogger({ level: "info", filePath: TEST_LOG_FILE });

      logger.info("test", "Empty data", {});

      const content = readFileSync(TEST_LOG_FILE, "utf8");
      const entry = JSON.parse(content.trim());

      // Empty object should be included but not displayed in console
      expect(entry.data).toEqual({});
    });
  });

  describe("error handling", () => {
    // Skip in CI: writing to /invalid/path/ may not trigger EACCES in all CI environments
    // (some runners run as root and CAN write to /invalid/path). The error-handling logic
    // is tested sufficiently by other unit tests for the Logger class itself.
    const skipInCI = process.env.CI ? test.skip : test;
    skipInCI("handles file write errors gracefully", () => {
      // Create logger with invalid path
      const originalError = console.error;
      const errors: string[] = [];
      console.error = (msg: string) => errors.push(msg);

      const logger = initLogger({
        level: "info",
        filePath: "/invalid/path/test.jsonl",
      });

      logger.info("test", "message");

      console.error = originalError;

      // Should log error to console but not crash
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
