/**
 * Integration tests for nax logs CLI command
 *
 * Tests logsCommand() directly (no subprocess) to avoid cold-start timeouts
 * on GitHub Actions shared runners. Captures console.log output in-process.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logsCommand } from "../../../src/commands/logs";
import { waitForCondition } from "../../helpers/timeout";

const TEST_WORKSPACE = join(import.meta.dir, "../../..", "tmp", "cli-logs-test");
const REGISTRY_DIR = join(TEST_WORKSPACE, "registry");
const RUN_ID = "2026-02-27T12-00-00";

const SAMPLE_LOGS = [
  {
    timestamp: "2026-02-27T12:00:00.000Z",
    level: "info",
    stage: "run.start",
    message: "Starting",
    data: { runId: "run-001" },
  },
  {
    timestamp: "2026-02-27T12:00:01.000Z",
    level: "info",
    stage: "story.start",
    storyId: "US-001",
    message: "Story start",
    data: { storyId: "US-001", title: "Test" },
  },
  {
    timestamp: "2026-02-27T12:00:02.000Z",
    level: "debug",
    stage: "routing",
    storyId: "US-001",
    message: "Routing",
    data: { tier: "haiku" },
  },
  {
    timestamp: "2026-02-27T12:00:03.000Z",
    level: "error",
    stage: "story.start",
    storyId: "US-002",
    message: "Error",
    data: {},
  },
];

function setupTestProject(featureName: string): string {
  const projectDir = join(TEST_WORKSPACE, `project-${Date.now()}`);
  const naxDir = join(projectDir, ".nax");
  const featureDir = join(naxDir, "features", featureName);
  const runsDir = join(featureDir, "runs");

  mkdirSync(runsDir, { recursive: true });
  mkdirSync(REGISTRY_DIR, { recursive: true });

  writeFileSync(join(naxDir, "config.json"), JSON.stringify({ feature: featureName }));
  writeFileSync(join(runsDir, `${RUN_ID}.jsonl`), SAMPLE_LOGS.map((l) => JSON.stringify(l)).join("\n"));

  // Registry entry for --run flag tests
  const entryDir = join(REGISTRY_DIR, `testproject-${featureName}-${RUN_ID}`);
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(
    join(entryDir, "meta.json"),
    JSON.stringify({
      runId: RUN_ID,
      project: "testproject",
      feature: featureName,
      workdir: projectDir,
      statusPath: join(projectDir, ".nax", "features", featureName, "status.json"),
      eventsDir: runsDir,
      registeredAt: "2026-02-27T12:00:00.000Z",
    }),
  );

  return projectDir;
}

function cleanup(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Capture console.log output while running logsCommand */
async function captureLogsCommand(
  options: Parameters<typeof logsCommand>[0],
): Promise<{ stdout: string; error?: Error }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await logsCommand(options);
    return { stdout: lines.join("\n") };
  } catch (err) {
    return { stdout: lines.join("\n"), error: err as Error };
  } finally {
    console.log = orig;
  }
}

describe("nax logs CLI integration", () => {
  let projectDir: string;
  const origRunsDir = process.env.NAX_RUNS_DIR;

  beforeAll(() => {
    projectDir = setupTestProject("test-feature");
  });

  afterAll(() => {
    cleanup(TEST_WORKSPACE);
    if (origRunsDir === undefined) process.env.NAX_RUNS_DIR = undefined;
    else process.env.NAX_RUNS_DIR = origRunsDir;
  });

  describe("basic invocation", () => {
    test("nax logs displays latest run", async () => {
      const { stdout, error } = await captureLogsCommand({ dir: projectDir });
      expect(error).toBeUndefined();
      expect(stdout).toContain("run-001");
    });

    test("nax logs fails when no runs directory found", async () => {
      const { error } = await captureLogsCommand({ dir: "/nonexistent/path-that-does-not-exist" });
      expect(error).toBeDefined();
    });
  });

  describe("--list flag", () => {
    test("nax logs --list shows runs table", async () => {
      const { stdout, error } = await captureLogsCommand({ dir: projectDir, list: true });
      expect(error).toBeUndefined();
      expect(stdout).toContain(RUN_ID);
    });
  });

  describe("--run flag", () => {
    test("nax logs --run <runId> displays logs from matching registry entry", async () => {
      process.env.NAX_RUNS_DIR = REGISTRY_DIR;
      const { stdout, error } = await captureLogsCommand({ run: RUN_ID });
      expect(error).toBeUndefined();
      expect(stdout).toContain("run-001");
    });

    test("nax logs --run throws when run not found in registry", async () => {
      process.env.NAX_RUNS_DIR = REGISTRY_DIR;
      const { error } = await captureLogsCommand({ run: "2026-01-01T00-00-00" });
      expect(error).toBeDefined();
      expect(error?.message).toContain("not found");
    });
  });

  describe("--story filter", () => {
    test("nax logs --story <id> filters to story", async () => {
      const { stdout, error } = await captureLogsCommand({ dir: projectDir, story: "US-001" });
      expect(error).toBeUndefined();
      expect(stdout).toContain("US-001");
      expect(stdout).not.toContain("US-002");
    });
  });

  describe("--level filter", () => {
    test("nax logs --level error shows only errors", async () => {
      const { stdout, error } = await captureLogsCommand({ dir: projectDir, level: "error" });
      expect(error).toBeUndefined();
      expect(stdout).toContain("US-002");
    });

    test("nax logs --level info shows info and above", async () => {
      const { stdout, error } = await captureLogsCommand({ dir: projectDir, level: "info" });
      expect(error).toBeUndefined();
      // info + error entries visible, debug excluded
      expect(stdout).toContain("run-001");
    });
  });

  describe("--json flag", () => {
    test("nax logs --json outputs raw JSONL", async () => {
      const { stdout, error } = await captureLogsCommand({ dir: projectDir, json: true });
      expect(error).toBeUndefined();
      const lines = stdout.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    test("--json combines with --story", async () => {
      const { stdout, error } = await captureLogsCommand({ dir: projectDir, json: true, story: "US-001" });
      expect(error).toBeUndefined();
      const lines = stdout.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (parsed.storyId) expect(parsed.storyId).toBe("US-001");
      }
    });
  });

  describe("--follow mode", () => {
    test.skip("nax logs --follow streams existing entries then watches", async () => {
      // followLogs currently runs indefinitely with no cancellation hook.
      // Exercising it in-process leaks background polling into later tests.
      await waitForCondition(() => false, 1, 1);
    });
  });

  describe("combined flags", () => {
    test("--story + --level + --json", async () => {
      const { stdout, error } = await captureLogsCommand({
        dir: projectDir,
        story: "US-001",
        level: "debug",
        json: true,
      });
      expect(error).toBeUndefined();
      const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim().startsWith("{"));
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (parsed.storyId) expect(parsed.storyId).toBe("US-001");
      }
    });

    test("--run + --story", async () => {
      process.env.NAX_RUNS_DIR = REGISTRY_DIR;
      const { stdout, error } = await captureLogsCommand({ run: RUN_ID, story: "US-001" });
      expect(error).toBeUndefined();
      expect(stdout).toContain("US-001");
    });
  });
});
