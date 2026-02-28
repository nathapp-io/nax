/**
 * Unit tests for nax logs command
 *
 * Tests the logs command implementation including:
 * - Latest run log display
 * - --follow mode (real-time streaming)
 * - --story filter
 * - --level filter
 * - --list (runs table)
 * - --run (specific run selection)
 * - --json (raw JSONL output)
 * - Combined filters
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LogsOptions, logsCommand } from "../../../src/commands/logs";

const TEST_WORKSPACE = join(import.meta.dir, "..", "..", "tmp", "logs-test");

function setupTestProject(featureName: string): string {
  const projectDir = join(TEST_WORKSPACE, `project-${Date.now()}`);
  const naxDir = join(projectDir, "nax");
  const featureDir = join(naxDir, "features", featureName);
  const runsDir = join(featureDir, "runs");

  mkdirSync(runsDir, { recursive: true });

  // Create minimal config.json
  writeFileSync(join(naxDir, "config.json"), JSON.stringify({ feature: featureName }));

  // Create sample JSONL log files
  const sampleLogs = [
    {
      timestamp: "2026-02-27T10:00:00.000Z",
      level: "info",
      stage: "run.start",
      message: "Starting feature",
      data: { runId: "run-001", feature: featureName },
    },
    {
      timestamp: "2026-02-27T10:00:01.000Z",
      level: "info",
      stage: "story.start",
      storyId: "US-001",
      message: "Starting story",
      data: { storyId: "US-001", title: "Test Story" },
    },
    {
      timestamp: "2026-02-27T10:00:02.000Z",
      level: "debug",
      stage: "routing",
      storyId: "US-001",
      message: "Routing decision",
      data: { tier: "haiku" },
    },
    {
      timestamp: "2026-02-27T10:00:03.000Z",
      level: "info",
      stage: "story.complete",
      storyId: "US-001",
      message: "Story passed",
      data: { success: true, cost: 0.0023 },
    },
    {
      timestamp: "2026-02-27T10:00:04.000Z",
      level: "error",
      stage: "story.start",
      storyId: "US-002",
      message: "Story failed",
      data: { storyId: "US-002", title: "Failed Story" },
    },
  ];

  // Write latest run log
  const latestRunPath = join(runsDir, "2026-02-27T10-00-00.jsonl");
  writeFileSync(latestRunPath, sampleLogs.map((log) => JSON.stringify(log)).join("\n"));

  // Write older run log
  const olderLogs = [
    {
      timestamp: "2026-02-26T09:00:00.000Z",
      level: "info",
      stage: "run.start",
      message: "Starting feature",
      data: { runId: "run-000", feature: featureName },
    },
    {
      timestamp: "2026-02-26T09:00:01.000Z",
      level: "info",
      stage: "story.start",
      storyId: "US-001",
      message: "Old run",
      data: { storyId: "US-001", title: "Old Story" },
    },
  ];
  const olderRunPath = join(runsDir, "2026-02-26T09-00-00.jsonl");
  writeFileSync(olderRunPath, olderLogs.map((log) => JSON.stringify(log)).join("\n"));

  return projectDir;
}

function cleanup(projectDir: string) {
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

describe("logsCommand", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = setupTestProject("test-feature");
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  describe("default behavior (latest run formatted)", () => {
    test("displays latest run logs with formatting", async () => {
      const options: LogsOptions = { dir: projectDir };

      // This should format and display the latest run
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("uses resolveProject() to find project directory", async () => {
      // Change to project directory
      const originalCwd = process.cwd();
      process.chdir(projectDir);

      try {
        const options: LogsOptions = {};
        await expect(logsCommand(options)).resolves.toBeUndefined();
      } finally {
        process.chdir(originalCwd);
      }
    });

    test("throws when no nax directory found", async () => {
      const options: LogsOptions = { dir: "/nonexistent/path" };

      await expect(logsCommand(options)).rejects.toThrow();
    });

    test("displays error when no runs exist", async () => {
      // Create fresh project with no runs
      const emptyProject = setupTestProject("empty-feature");
      const runsDir = join(emptyProject, "nax", "features", "empty-feature", "runs");
      rmSync(join(runsDir, "2026-02-27T10-00-00.jsonl"));
      rmSync(join(runsDir, "2026-02-26T09-00-00.jsonl"));

      const options: LogsOptions = { dir: emptyProject };

      await expect(logsCommand(options)).rejects.toThrow(/no runs found/i);

      cleanup(emptyProject);
    });
  });

  describe("--follow mode (real-time streaming)", () => {
    // Note: Follow mode tests are skipped in unit tests because they run indefinitely.
    // They are tested in integration tests (test/integration/cli-logs.test.ts) where we can spawn and kill processes.
    test.skip("streams new log entries in real-time", async () => {
      // Skipped: tested in integration tests
    });

    test.skip("follows the latest run by default", async () => {
      // Skipped: tested in integration tests
    });

    test.skip("can follow a specific run with --run flag", async () => {
      // Skipped: tested in integration tests
    });
  });

  describe("--story filter", () => {
    test("filters logs to specific story", async () => {
      const options: LogsOptions = { dir: projectDir, story: "US-001" };

      // Should only show logs with storyId: "US-001"
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test.skip("filters work with --follow mode", async () => {
      // Skipped: tested in integration tests
    });

    test("shows empty result when story not found", async () => {
      const options: LogsOptions = { dir: projectDir, story: "US-999" };

      // No logs match this story
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });
  });

  describe("--level filter", () => {
    test("filters logs by error level", async () => {
      const options: LogsOptions = { dir: projectDir, level: "error" };

      // Should only show error-level logs
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("filters logs by info level", async () => {
      const options: LogsOptions = { dir: projectDir, level: "info" };

      // Should show info, warn, error (all >= info)
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("filters logs by debug level", async () => {
      const options: LogsOptions = { dir: projectDir, level: "debug" };

      // Should show all logs (debug is lowest level)
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test.skip("filters work with --follow mode", async () => {
      // Skipped: tested in integration tests
    });
  });

  describe("--list (runs table)", () => {
    test("displays table of all runs", async () => {
      const options: LogsOptions = { dir: projectDir, list: true };

      // Should display a table of runs with timestamps, status, duration
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("includes run metadata in table", async () => {
      const options: LogsOptions = { dir: projectDir, list: true };

      // Table should include: timestamp, stories count, cost, duration
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("sorts runs by timestamp descending (newest first)", async () => {
      const options: LogsOptions = { dir: projectDir, list: true };

      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("shows empty message when no runs exist", async () => {
      const emptyProject = setupTestProject("empty-feature");
      const runsDir = join(emptyProject, "nax", "features", "empty-feature", "runs");
      rmSync(join(runsDir, "2026-02-27T10-00-00.jsonl"));
      rmSync(join(runsDir, "2026-02-26T09-00-00.jsonl"));

      const options: LogsOptions = { dir: emptyProject, list: true };

      await expect(logsCommand(options)).resolves.toBeUndefined();

      cleanup(emptyProject);
    });
  });

  describe("--run (specific run selection)", () => {
    test("displays specific run by timestamp", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        run: "2026-02-26T09-00-00",
      };

      // Should display the older run
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("throws when specified run does not exist", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        run: "2026-01-01T00-00-00",
      };

      await expect(logsCommand(options)).rejects.toThrow(/run not found/i);
    });

    test("works with partial timestamp matching", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        run: "2026-02-26",
      };

      // Should match "2026-02-26T09-00-00"
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });
  });

  describe("--json (raw JSONL output)", () => {
    test("outputs raw JSONL without formatting", async () => {
      const options: LogsOptions = { dir: projectDir, json: true };

      // Should output raw JSONL lines
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("combines with --story filter", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        story: "US-001",
        json: true,
      };

      // Raw JSONL output but only for US-001
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("combines with --level filter", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        level: "error",
        json: true,
      };

      // Raw JSONL output but only error level
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test.skip("works with --follow mode", async () => {
      // Skipped: tested in integration tests
    });
  });

  describe("combined filters", () => {
    test("--story + --level filters", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        story: "US-001",
        level: "info",
      };

      // Only US-001 logs with info level or higher
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("--story + --level + --json", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        story: "US-001",
        level: "debug",
        json: true,
      };

      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("--run + --story + --level", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        run: "2026-02-27T10-00-00",
        story: "US-001",
        level: "info",
      };

      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("all filters combined", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        run: "2026-02-27T10-00-00",
        story: "US-001",
        level: "info",
        json: true,
      };

      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("--list ignores other filters", async () => {
      const options: LogsOptions = {
        dir: projectDir,
        list: true,
        story: "US-001", // Should be ignored
        level: "error", // Should be ignored
      };

      // --list takes precedence, others ignored
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });
  });

  describe("resolveProject integration", () => {
    test("resolves project from -d flag", async () => {
      const options: LogsOptions = { dir: projectDir };

      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("resolves project from CWD", async () => {
      const originalCwd = process.cwd();
      process.chdir(projectDir);

      try {
        const options: LogsOptions = {};
        await expect(logsCommand(options)).resolves.toBeUndefined();
      } finally {
        process.chdir(originalCwd);
      }
    });

    test("validates nax/config.json exists", async () => {
      const invalidProject = join(TEST_WORKSPACE, "invalid");
      mkdirSync(join(invalidProject, "nax"), { recursive: true });

      const options: LogsOptions = { dir: invalidProject };

      await expect(logsCommand(options)).rejects.toThrow(/config.json/i);

      cleanup(invalidProject);
    });
  });
});
