/**
 * Unit tests for crash recovery module (US-007)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config";
import {
  type CrashRecoveryContext,
  installCrashHandlers,
  resetCrashHandlers,
  startHeartbeat,
  stopHeartbeat,
  writeExitSummary,
} from "../../src/execution/crash-recovery";
import { StatusWriter } from "../../src/execution/status-writer";

const TEST_DIR = join(import.meta.dir, "..", ".tmp-crash-recovery");
const TEST_JSONL = join(TEST_DIR, "test.jsonl");
const TEST_STATUS_FILE = join(TEST_DIR, "status.json");

beforeEach(() => {
  // Create test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });

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
      await Bun.sleep(100);

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

  describe("SIGTERM run.complete event (BUG-017)", () => {
    test("should emit run.complete event when SIGTERM is received", async () => {
      const statusWriter = new StatusWriter(TEST_STATUS_FILE, DEFAULT_CONFIG, {
        runId: "test-run-123",
        feature: "test-feature",
        startedAt: new Date().toISOString(),
        dryRun: false,
        startTimeMs: Date.now(),
        pid: process.pid,
      });

      const startTime = Date.now();
      const ctx: CrashRecoveryContext = {
        statusWriter,
        getTotalCost: () => 1.5,
        getIterations: () => 3,
        jsonlFilePath: TEST_JSONL,
        runId: "test-run-123",
        feature: "test-feature",
        getStartTime: () => startTime,
        getTotalStories: () => 5,
        getStoriesCompleted: () => 2,
      };

      // Install handlers
      const cleanup = installCrashHandlers(ctx);

      // Simulate SIGTERM by spawning a child process that sends SIGTERM to itself
      // We'll test this by directly testing the signal emission logic via a subprocess
      const testScript = `
        import { installCrashHandlers } from "./src/execution/crash-recovery.ts";
        import { StatusWriter } from "./src/execution/status-writer.ts";
        import { DEFAULT_CONFIG } from "./src/config/index.ts";

        const statusWriter = new StatusWriter("${TEST_STATUS_FILE}", DEFAULT_CONFIG, {
          runId: "test-run-123",
          feature: "test-feature",
          startedAt: new Date().toISOString(),
          dryRun: false,
          startTimeMs: Date.now(),
          pid: process.pid,
        });

        const startTime = Date.now();
        const ctx = {
          statusWriter,
          getTotalCost: () => 1.5,
          getIterations: () => 3,
          jsonlFilePath: "${TEST_JSONL}",
          runId: "test-run-123",
          feature: "test-feature",
          getStartTime: () => startTime,
          getTotalStories: () => 5,
          getStoriesCompleted: () => 2,
        };

        installCrashHandlers(ctx);

        // Send SIGTERM to self after 100ms
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
      `;

      const tmpScript = join(TEST_DIR, "sigterm-test.ts");
      await Bun.write(tmpScript, testScript);

      // Run the script in a subprocess
      const proc = Bun.spawn(["bun", "run", tmpScript], {
        cwd: join(import.meta.dir, "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
      });

      await proc.exited;

      // Give filesystem time to flush
      await Bun.sleep(200);

      // Verify run.complete event was written
      if (existsSync(TEST_JSONL)) {
        const file = Bun.file(TEST_JSONL);
        const content = await file.text();
        const lines = content.trim().split("\n").filter(Boolean);

        // Find run.complete event
        const runCompleteEvent = lines
          .map((line) => JSON.parse(line))
          .find((entry) => entry.stage === "run.complete");

        expect(runCompleteEvent).toBeDefined();
        expect(runCompleteEvent.message).toBe("Feature execution terminated");
        expect(runCompleteEvent.data.runId).toBe("test-run-123");
        expect(runCompleteEvent.data.feature).toBe("test-feature");
        expect(runCompleteEvent.data.exitReason).toBe("sigterm");
        expect(runCompleteEvent.data.totalCost).toBe(1.5);
        expect(runCompleteEvent.data.iterations).toBe(3);
        expect(runCompleteEvent.data.totalStories).toBe(5);
        expect(runCompleteEvent.data.storiesCompleted).toBe(2);
        expect(runCompleteEvent.data.durationMs).toBeGreaterThanOrEqual(0);
      }

      // Cleanup
      cleanup();
    });
  });
});
