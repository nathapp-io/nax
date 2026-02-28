/**
 * Integration test for headless mode with formatter
 *
 * Verifies that `nax run` uses formatted output in headless mode
 * instead of raw JSONL, while still writing JSONL to disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { initLogger, resetLogger } from "../../src/logger";

describe("Headless mode formatter integration", () => {
  const testDir = join(import.meta.dir, "..", "tmp", "headless-test");
  const logFile = join(testDir, "test.jsonl");

  beforeEach(() => {
    // Clean up any existing logger
    resetLogger();

    // Create test directory
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    resetLogger();
  });

  test("logger uses formatter in headless mode with normal verbosity", async () => {
    // Initialize logger in headless mode with normal verbosity
    const logger = initLogger({
      level: "info",
      filePath: logFile,
      useChalk: false, // Disable colors for test output
      formatterMode: "normal",
      headless: true,
    });

    // Capture console output
    const originalLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => {
      outputs.push(msg);
    };

    try {
      // Log a test message
      logger.info("test.stage", "Test message", { foo: "bar" });

      // Verify console output uses formatter (not raw JSONL)
      expect(outputs.length).toBeGreaterThan(0);
      const output = outputs[0];

      // Should NOT be raw JSON
      expect(output.startsWith("{")).toBe(false);

      // Should contain formatted elements
      expect(output).toContain("test.stage");
      expect(output).toContain("Test message");
    } finally {
      console.log = originalLog;
    }

    // Verify JSONL file was written
    expect(existsSync(logFile)).toBe(true);
    const fileContent = await Bun.file(logFile).text();
    expect(fileContent).toContain('"stage":"test.stage"');
    expect(fileContent).toContain('"message":"Test message"');
  });

  test("logger outputs raw JSONL in json mode", () => {
    // Initialize logger in headless mode with json verbosity
    const logger = initLogger({
      level: "info",
      filePath: logFile,
      useChalk: false,
      formatterMode: "json",
      headless: true,
    });

    // Capture console output
    const originalLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => {
      outputs.push(msg);
    };

    try {
      // Log a test message
      logger.info("test.stage", "Test message", { foo: "bar" });

      // Verify console output is raw JSONL
      expect(outputs.length).toBe(1);
      const output = outputs[0];

      // Should be valid JSON
      const parsed = JSON.parse(output);
      expect(parsed.stage).toBe("test.stage");
      expect(parsed.message).toBe("Test message");
      expect(parsed.data.foo).toBe("bar");
    } finally {
      console.log = originalLog;
    }
  });

  test("logger suppresses debug logs in quiet mode", () => {
    // Initialize logger in quiet mode
    const logger = initLogger({
      level: "debug", // Log level allows everything through
      filePath: logFile,
      useChalk: false,
      formatterMode: "quiet", // Formatter filters what's displayed
      headless: true,
    });

    // Capture console output
    const originalLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => {
      outputs.push(msg);
    };

    try {
      // Log debug and info messages
      logger.debug("test.stage", "Debug message");
      logger.info("test.stage", "Info message");

      // In quiet mode, info logs should be filtered out
      // (unless they're critical events like run.start/run.end)
      expect(outputs.length).toBe(0);

      // But errors should still show (reset outputs first)
      outputs.length = 0;
      logger.error("test.stage", "Error message");
      expect(outputs.length).toBe(1);
      expect(outputs[0]).toContain("Error message");
    } finally {
      console.log = originalLog;
    }
  });

  test("logger uses default console formatter when not in headless mode", () => {
    // Initialize logger WITHOUT headless mode
    const logger = initLogger({
      level: "info",
      filePath: logFile,
      useChalk: false,
      headless: false, // Not headless
    });

    // Capture console output
    const originalLog = console.log;
    const outputs: string[] = [];
    console.log = (msg: string) => {
      outputs.push(msg);
    };

    try {
      // Log a test message
      logger.info("test.stage", "Test message", { foo: "bar" });

      // Verify console output uses default console formatter (not formatter)
      expect(outputs.length).toBeGreaterThan(0);
      const output = outputs[0];

      // Default console format includes [timestamp] [stage] message
      expect(output).toContain("[test.stage]");
      expect(output).toContain("Test message");
    } finally {
      console.log = originalLog;
    }
  });
});
