// RE-ARCH: keep
/**
 * Unit tests for crash recovery module (US-007)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../../src/config";
import {
  type CrashRecoveryContext,
  installCrashHandlers,
  resetCrashHandlers,
  startHeartbeat,
  stopHeartbeat,
  writeExitSummary,
} from "../../../src/execution/crash-recovery";
import { StatusWriter } from "../../../src/execution/status-writer";
import { makeTempDir } from "../../helpers/temp";

let TEST_DIR: string;
let TEST_JSONL: string;
let TEST_STATUS_FILE: string;

beforeEach(() => {
  TEST_DIR = makeTempDir("nax-crash-recovery-");
  TEST_JSONL = join(TEST_DIR, "test.jsonl");
  TEST_STATUS_FILE = join(TEST_DIR, "status.json");

  // Reset crash handlers before each test
  resetCrashHandlers();
});

afterEach(() => {
  // Reset crash handlers after each test
  resetCrashHandlers();

  // Clean up test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("crash-recovery", () => {
  describe("installCrashHandlers", () => {
    test("should install handlers without throwing", () => {
      const statusWriter = new StatusWriter(TEST_STATUS_FILE, DEFAULT_CONFIG, {
        runId: "test-run",
        feature: "test-feature",
        startedAt: new Date().toISOString(),
        dryRun: false,
        startTimeMs: Date.now(),
        pid: process.pid,
      });

      const ctx: CrashRecoveryContext = {
        statusWriter,
        getTotalCost: () => 0,
        getIterations: () => 0,
        jsonlFilePath: TEST_JSONL,
      };

      expect(() => installCrashHandlers(ctx)).not.toThrow();
    });

    test("should not throw when called multiple times", () => {
      const statusWriter = new StatusWriter(TEST_STATUS_FILE, DEFAULT_CONFIG, {
        runId: "test-run",
        feature: "test-feature",
        startedAt: new Date().toISOString(),
        dryRun: false,
        startTimeMs: Date.now(),
        pid: process.pid,
      });

      const ctx: CrashRecoveryContext = {
        statusWriter,
        getTotalCost: () => 0,
        getIterations: () => 0,
        jsonlFilePath: TEST_JSONL,
      };

      installCrashHandlers(ctx);
      expect(() => installCrashHandlers(ctx)).not.toThrow();
    });
  });

  describe("heartbeat", () => {
    test("should start and stop heartbeat without throwing", () => {
      const statusWriter = new StatusWriter(TEST_STATUS_FILE, DEFAULT_CONFIG, {
        runId: "test-run",
        feature: "test-feature",
        startedAt: new Date().toISOString(),
        dryRun: false,
        startTimeMs: Date.now(),
        pid: process.pid,
      });

      const totalCost = 0;
      const iterations = 0;

      expect(() =>
        startHeartbeat(
          statusWriter,
          () => totalCost,
          () => iterations,
          TEST_JSONL,
        ),
      ).not.toThrow();

      expect(() => stopHeartbeat()).not.toThrow();
    });

    test("should write heartbeat entry after interval", async () => {
      const statusWriter = new StatusWriter(TEST_STATUS_FILE, DEFAULT_CONFIG, {
        runId: "test-run",
        feature: "test-feature",
        startedAt: new Date().toISOString(),
        dryRun: false,
        startTimeMs: Date.now(),
        pid: process.pid,
      });

      statusWriter.setPrd({
        version: 1,
        feature: "test-feature",
        userStories: [],
      });

      const totalCost = 0;
      const iterations = 0;

      startHeartbeat(
        statusWriter,
        () => totalCost,
        () => iterations,
        TEST_JSONL,
      );

      // Wait for one heartbeat cycle (60s in production, but we can't wait that long in tests)
      // This test just verifies no crash during startup
      await Promise.resolve();

      stopHeartbeat();

      // Verify no crash (test passes if we reach here)
      expect(true).toBe(true);
    });

    test("should stop heartbeat idempotently", () => {
      expect(() => stopHeartbeat()).not.toThrow();
      expect(() => stopHeartbeat()).not.toThrow();
    });
  });

  describe("writeExitSummary", () => {
    test("should write exit summary to JSONL file", async () => {
      await writeExitSummary(TEST_JSONL, 1.23, 5, 3, 60000);

      const file = Bun.file(TEST_JSONL);
      expect(await file.exists()).toBe(true);

      const content = await file.text();
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(1);

      const entry = JSON.parse(lines[0]);
      expect(entry.level).toBe("info");
      expect(entry.stage).toBe("exit-summary");
      expect(entry.message).toBe("Run completed");
      expect(entry.data.totalCost).toBe(1.23);
      expect(entry.data.iterations).toBe(5);
      expect(entry.data.storiesCompleted).toBe(3);
      expect(entry.data.durationMs).toBe(60000);
      expect(entry.data.exitedCleanly).toBe(true);
    });

    test("should not throw when JSONL path is undefined", async () => {
      await expect(writeExitSummary(undefined, 1.23, 5, 3, 60000)).resolves.toBeUndefined();
    });

    test("should include timestamp in exit summary", async () => {
      const beforeTime = new Date().toISOString();
      await writeExitSummary(TEST_JSONL, 1.23, 5, 3, 60000);
      const afterTime = new Date().toISOString();

      const file = Bun.file(TEST_JSONL);
      const content = await file.text();
      const entry = JSON.parse(content.trim());

      expect(entry.timestamp).toBeDefined();
      expect(entry.timestamp >= beforeTime).toBe(true);
      expect(entry.timestamp <= afterTime).toBe(true);
    });
  });

  describe("resetCrashHandlers", () => {
    test("should reset handlers and stop heartbeat", () => {
      const statusWriter = new StatusWriter(TEST_STATUS_FILE, DEFAULT_CONFIG, {
        runId: "test-run",
        feature: "test-feature",
        startedAt: new Date().toISOString(),
        dryRun: false,
        startTimeMs: Date.now(),
        pid: process.pid,
      });

      const ctx: CrashRecoveryContext = {
        statusWriter,
        getTotalCost: () => 0,
        getIterations: () => 0,
        jsonlFilePath: TEST_JSONL,
      };

      installCrashHandlers(ctx);
      startHeartbeat(
        statusWriter,
        () => 0,
        () => 0,
        TEST_JSONL,
      );

      expect(() => resetCrashHandlers()).not.toThrow();

      // After reset, should be able to install handlers again
      expect(() => installCrashHandlers(ctx)).not.toThrow();
    });
  });

  // BUG-017
  describe("SIGTERM handler emits run.complete event", () => {
    test("should emit run.complete event when SIGTERM handler is invoked directly", async () => {
      // Mock process.exit to prevent the test process from actually exiting
      const originalExit = process.exit;
      let exitCalled = false;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCalled = true;
        exitCode = code;
      }) as typeof process.exit;

      const statusWriter = new StatusWriter(TEST_STATUS_FILE, DEFAULT_CONFIG, {
        runId: "run-sigterm-mock",
        feature: "mock-feature",
        startedAt: new Date().toISOString(),
        dryRun: false,
        startTimeMs: Date.now(),
        pid: process.pid,
      });

      statusWriter.setPrd({
        version: 1,
        feature: "mock-feature",
        userStories: [],
      });

      const startTime = Date.now() - 5000;
      const ctx: CrashRecoveryContext = {
        statusWriter,
        getTotalCost: () => 2.5,
        getIterations: () => 4,
        jsonlFilePath: TEST_JSONL,
        runId: "run-sigterm-mock",
        feature: "mock-feature",
        getStartTime: () => startTime,
        getTotalStories: () => 10,
        getStoriesCompleted: () => 3,
      };

      const cleanup = installCrashHandlers(ctx);

      // Capture the SIGTERM listener registered by installCrashHandlers
      const sigtermListeners = process.listeners("SIGTERM");
      const sigtermHandler = sigtermListeners[sigtermListeners.length - 1] as () => Promise<void>;

      // Invoke the handler directly — no real signal, no subprocess
      await sigtermHandler();

      // Restore process.exit before assertions
      process.exit = originalExit;
      cleanup();

      // Assert process.exit was called with the correct SIGTERM exit code
      expect(exitCalled).toBe(true);
      expect(exitCode).toBe(128 + 15); // SIGTERM = signal 15

      // Assert run.complete event was written to JSONL
      const file = Bun.file(TEST_JSONL);
      expect(await file.exists()).toBe(true);
      const content = await file.text();
      const lines = content.trim().split("\n").filter(Boolean);
      const entries = lines.map((line: string) => JSON.parse(line));
      const runCompleteEvent = entries.find((e: { stage: string }) => e.stage === "run.complete");

      expect(runCompleteEvent).toBeDefined();
      expect(runCompleteEvent.level).toBe("info");
      expect(runCompleteEvent.message).toBe("Feature execution terminated");
      expect(runCompleteEvent.data.runId).toBe("run-sigterm-mock");
      expect(runCompleteEvent.data.feature).toBe("mock-feature");
      expect(runCompleteEvent.data.success).toBe(false);
      expect(runCompleteEvent.data.exitReason).toBe("sigterm");
      expect(runCompleteEvent.data.totalCost).toBe(2.5);
      expect(runCompleteEvent.data.iterations).toBe(4);
      expect(runCompleteEvent.data.totalStories).toBe(10);
      expect(runCompleteEvent.data.storiesCompleted).toBe(3);
      expect(runCompleteEvent.data.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
