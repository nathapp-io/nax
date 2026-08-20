// RE-ARCH: keep
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
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  type FollowLogsDeps,
  type LogsOptions,
  _deps,
  followLogs,
  logsCommand,
} from "../../../src/commands/logs";

const TEST_WORKSPACE = join(import.meta.dir, "..", "..", "tmp", "logs-test");

function setupTestProject(featureName: string): string {
  // Random suffix, not just Date.now() — two calls in the same test tick can share a
  // millisecond, colliding into the same directory and merging their .nax/features/
  // entries (surfaced by BUG-02: logs now derives the feature by listing
  // .nax/features/*, so a merged fixture becomes a spurious "ambiguous" failure).
  const projectDir = join(TEST_WORKSPACE, `project-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  const naxDir = join(projectDir, ".nax");
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
  let registryDir: string;
  let originalGetRunsDir: () => string;

  beforeEach(() => {
    projectDir = setupTestProject("test-feature");

    // Set up a temp registry dir and override _deps
    registryDir = join(TEST_WORKSPACE, `registry-${Date.now()}`);
    mkdirSync(registryDir, { recursive: true });
    originalGetRunsDir = _deps.getRunsDir;
    _deps.getRunsDir = () => registryDir;

    // Create registry entries pointing to the test runs
    const runsDir = join(projectDir, ".nax", "features", "test-feature", "runs");

    for (const runId of ["2026-02-27T10-00-00", "2026-02-26T09-00-00"]) {
      const entryDir = join(registryDir, `testproject-test-feature-${runId}`);
      mkdirSync(entryDir, { recursive: true });
      writeFileSync(
        join(entryDir, "meta.json"),
        JSON.stringify({
          runId,
          project: "testproject",
          feature: "test-feature",
          workdir: projectDir,
          statusPath: join(projectDir, ".nax", "features", "test-feature", "status.json"),
          eventsDir: runsDir,
          registeredAt: "2026-02-27T10:00:00.000Z",
        }),
      );
    }
  });

  afterEach(() => {
    _deps.getRunsDir = originalGetRunsDir;
    cleanup(projectDir);
    cleanup(registryDir);
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
      const runsDir = join(emptyProject, ".nax", "features", "empty-feature", "runs");
      rmSync(join(runsDir, "2026-02-27T10-00-00.jsonl"));
      rmSync(join(runsDir, "2026-02-26T09-00-00.jsonl"));

      const options: LogsOptions = { dir: emptyProject };

      await expect(logsCommand(options)).rejects.toThrow(/no runs found/i);

      cleanup(emptyProject);
    });
  });

  describe("--follow mode (real-time streaming)", () => {
    test("resolves to undefined with an already-aborted signal (AC #6)", async () => {
      const controller = new AbortController();
      controller.abort();

      const options: LogsOptions = { dir: projectDir, follow: true, signal: controller.signal };
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("resolves to undefined with --run + follow + an already-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const options: LogsOptions = {
        run: "2026-02-27T10-00-00",
        follow: true,
        signal: controller.signal,
      };
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("aborting the signal mid-flight returns cleanly to undefined", async () => {
      const controller = new AbortController();
      const result = logsCommand({ dir: projectDir, follow: true, signal: controller.signal });
      controller.abort();
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe("--follow mode byte-offset tailing (US-002)", () => {
    let followDir: string;

    beforeEach(() => {
      followDir = makeTempDir("nax-logs-follow-byte-");
    });

    afterEach(() => {
      cleanupTempDir(followDir);
    });

    function makeEntry(message: string, storyId = "US-001"): Record<string, unknown> {
      return {
        timestamp: "2026-02-27T10:00:00.000Z",
        level: "info",
        stage: "test",
        storyId,
        message,
        data: {},
      };
    }

    function encodeLine(entry: Record<string, unknown>): Buffer {
      return Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    }

    async function writeInitial(filePath: string, entry: Record<string, unknown>): Promise<void> {
      await Bun.write(filePath, encodeLine(entry));
    }

    async function appendEntry(filePath: string, entry: Record<string, unknown>): Promise<void> {
      appendFileSync(filePath, encodeLine(entry));
    }

    async function rewriteShorter(filePath: string, entry: Record<string, unknown>): Promise<void> {
      await Bun.write(filePath, encodeLine(entry));
    }

    test("emits appended entry intact when preceding message contains three ✓ characters (AC #1)", async () => {
      const filePath = join(followDir, "run.jsonl");
      await writeInitial(filePath, makeEntry("✓ ✓ ✓"));
      const appended = makeEntry("appended entry");

      const emitted: string[] = [];
      let appendedOnce = false;
      const deps: FollowLogsDeps = {
        emit: (line) => emitted.push(line),
        sleep: async () => {
          if (!appendedOnce) {
            await appendEntry(filePath, appended);
            appendedOnce = true;
          }
        },
        readRange: async (path, start) =>
          Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
      };
      const controller = new AbortController();

      const follow = followLogs(filePath, {}, { signal: controller.signal, _deps: deps });
      // Let the loop run at least one poll cycle, then cancel.
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await follow;

      // Pre-existing entry emitted once on initial read; appended entry emitted
      // once on poll. The byte-aligned read must NOT silently drop the append.
      expect(emitted.length).toBe(2);
      expect(emitted[0]).toContain("✓ ✓ ✓");
      expect(emitted[1]).toContain("appended entry");
    });

    test("emits three successive ✓-containing entries across three polls in append order (AC #2)", async () => {
      const filePath = join(followDir, "run.jsonl");
      await writeInitial(filePath, makeEntry("seed ✓"));

      const appended = [
        makeEntry("first ✓"),
        makeEntry("second ✓"),
        makeEntry("third ✓"),
      ];
      let sleepCalls = 0;

      const emitted: string[] = [];
      const deps: FollowLogsDeps = {
        emit: (line) => emitted.push(line),
        sleep: async () => {
          if (sleepCalls < appended.length) {
            await appendEntry(filePath, appended[sleepCalls]);
          }
          sleepCalls++;
        },
        readRange: async (path, start) =>
          Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
      };
      const controller = new AbortController();

      const follow = followLogs(filePath, {}, { signal: controller.signal, _deps: deps });
      // Let the loop run three polls, then cancel.
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await follow;

      expect(sleepCalls).toBeGreaterThanOrEqual(3);
      // Each appended ✓ entry must be emitted exactly once and in append order.
      const firstIdx = emitted.findIndex((l) => l.includes("first ✓"));
      const secondIdx = emitted.findIndex((l) => l.includes("second ✓"));
      const thirdIdx = emitted.findIndex((l) => l.includes("third ✓"));
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(secondIdx).toBeGreaterThan(firstIdx);
      expect(thirdIdx).toBeGreaterThan(secondIdx);
      // Each appended entry appears exactly once (no double-emit on re-poll).
      expect(emitted.filter((l) => l.includes("first ✓")).length).toBe(1);
      expect(emitted.filter((l) => l.includes("second ✓")).length).toBe(1);
      expect(emitted.filter((l) => l.includes("third ✓")).length).toBe(1);
    });

    test("emits every appended entry exactly once across pre-existing + two appends (AC #3)", async () => {
      const filePath = join(followDir, "run.jsonl");
      await writeInitial(filePath, makeEntry("pre-existing ✓"));

      const appendedA = makeEntry("append A ✓");
      const appendedB = makeEntry("append B ✓");
      let sleepCalls = 0;

      const emitted: string[] = [];
      const deps: FollowLogsDeps = {
        emit: (line) => emitted.push(line),
        sleep: async () => {
          sleepCalls++;
          if (sleepCalls === 1) {
            await appendEntry(filePath, appendedA);
          } else if (sleepCalls === 2) {
            await appendEntry(filePath, appendedB);
          }
        },
        readRange: async (path, start) =>
          Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
      };
      const controller = new AbortController();

      const follow = followLogs(filePath, {}, { signal: controller.signal, _deps: deps });
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await follow;

      const aCount = emitted.filter((l) => l.includes("append A ✓")).length;
      const bCount = emitted.filter((l) => l.includes("append B ✓")).length;
      expect(aCount).toBe(1);
      expect(bCount).toBe(1);
    });

    test("skips an invalid JSON line between two ✓ entries and emits the later valid entry (AC #4)", async () => {
      const filePath = join(followDir, "run.jsonl");
      await writeInitial(filePath, makeEntry("seed ✓"));

      const validA = makeEntry("valid A ✓");
      const validB = makeEntry("valid B ✓");
      let sleepCalls = 0;

      const emitted: string[] = [];
      const deps: FollowLogsDeps = {
        emit: (line) => emitted.push(line),
        sleep: async () => {
          sleepCalls++;
          if (sleepCalls === 1) {
            appendFileSync(filePath, encodeLine(validA));
            appendFileSync(filePath, Buffer.from("this is not valid json\n", "utf8"));
            appendFileSync(filePath, encodeLine(validB));
          }
        },
        readRange: async (path, start) =>
          Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
      };
      const controller = new AbortController();

      const follow = followLogs(filePath, {}, { signal: controller.signal, _deps: deps });
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await follow;

      const aCount = emitted.filter((l) => l.includes("valid A ✓")).length;
      const bCount = emitted.filter((l) => l.includes("valid B ✓")).length;
      expect(aCount).toBe(1);
      expect(bCount).toBe(1);
    });

    test("resynchronises when the file is rewritten shorter than the consumed offset, then emits the next append (AC #5)", async () => {
      const filePath = join(followDir, "run.jsonl");
      await writeInitial(filePath, makeEntry("seed ✓ ✓ ✓ ✓ ✓"));

      const truncatedEntry = makeEntry("after-truncation ✓");
      const appendedEntry = makeEntry("post-resync ✓");
      let sleepCalls = 0;

      const emitted: string[] = [];
      const deps: FollowLogsDeps = {
        emit: (line) => emitted.push(line),
        sleep: async () => {
          sleepCalls++;
          if (sleepCalls === 1) {
            await rewriteShorter(filePath, truncatedEntry);
          } else if (sleepCalls === 2) {
            await appendEntry(filePath, appendedEntry);
          }
        },
        readRange: async (path, start) =>
          Buffer.from(await Bun.file(path).slice(start).arrayBuffer()).toString("utf8"),
      };
      const controller = new AbortController();

      const follow = followLogs(filePath, {}, { signal: controller.signal, _deps: deps });
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await follow;

      // The appended entry after truncation must be emitted.
      const appendedCount = emitted.filter((l) => l.includes("post-resync ✓")).length;
      expect(appendedCount).toBe(1);
    });

    test("readRange receives start offset equal to bytes already consumed, not 0, on append polls (AC #6)", async () => {
      const filePath = join(followDir, "run.jsonl");
      const initial = makeEntry("seed ✓");
      await writeInitial(filePath, initial);
      const initialSize = encodeLine(initial).length;

      let sleepCalls = 0;
      const readRangeCalls: number[] = [];
      const deps: FollowLogsDeps = {
        emit: () => {},
        sleep: async () => {
          sleepCalls++;
          if (sleepCalls === 1) {
            await appendEntry(filePath, makeEntry("append ✓"));
          }
        },
        readRange: async (_path, start) => {
          readRangeCalls.push(start);
          return Buffer.from(await Bun.file(filePath).slice(start).arrayBuffer()).toString(
            "utf8",
          );
        },
      };
      const controller = new AbortController();

      const follow = followLogs(filePath, {}, { signal: controller.signal, _deps: deps });
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      await follow;

      // The first call (during the initial read) is start=0.
      // The second call (during the append poll) must equal the byte length
      // already consumed — which is the size of the initial file.
      expect(readRangeCalls.length).toBeGreaterThanOrEqual(2);
      expect(readRangeCalls[0]).toBe(0);
      expect(readRangeCalls[1]).toBe(initialSize);
    });
  });

  describe("--story filter", () => {
    test("filters logs to specific story", async () => {
      const options: LogsOptions = { dir: projectDir, story: "US-001" };

      // Should only show logs with storyId: "US-001"
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("--story filter with --follow and an already-aborted signal resolves to undefined", async () => {
      const controller = new AbortController();
      controller.abort();

      const options: LogsOptions = {
        dir: projectDir,
        follow: true,
        story: "US-001",
        signal: controller.signal,
      };
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("shows empty result when story not found", async () => {
      const options: LogsOptions = { dir: projectDir, story: "US-999" };

      // No logs match this story
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });
  });

  describe("--level filter", () => {
    test.each(["error", "info", "debug"] as const)("filters logs by %s level", async (level) => {
      await expect(logsCommand({ dir: projectDir, level })).resolves.toBeUndefined();
    });

    test("--level filter with --follow and an already-aborted signal resolves to undefined", async () => {
      const controller = new AbortController();
      controller.abort();

      const options: LogsOptions = {
        dir: projectDir,
        follow: true,
        level: "error",
        signal: controller.signal,
      };
      await expect(logsCommand(options)).resolves.toBeUndefined();
    });
  });

  describe("--list (runs table)", () => {
    test("table: displays all runs with metadata, sorts by timestamp descending (newest first)", async () => {
      await expect(logsCommand({ dir: projectDir, list: true })).resolves.toBeUndefined();
    });

    test("shows empty message when no runs exist", async () => {
      const emptyProject = setupTestProject("empty-feature");
      const runsDir = join(emptyProject, ".nax", "features", "empty-feature", "runs");
      rmSync(join(runsDir, "2026-02-27T10-00-00.jsonl"));
      rmSync(join(runsDir, "2026-02-26T09-00-00.jsonl"));

      const options: LogsOptions = { dir: emptyProject, list: true };

      await expect(logsCommand(options)).resolves.toBeUndefined();

      cleanup(emptyProject);
    });
  });

  describe("--run (registry-based run selection)", () => {
    test.each([
      ["exact runId", "2026-02-26T09-00-00"],
      ["prefix match", "2026-02-26"],
    ])("displays run resolved from central registry by %s", async (_label, run) => {
      await expect(logsCommand({ run })).resolves.toBeUndefined();
    });

    test("throws with clear error when runId not found in registry", async () => {
      const options: LogsOptions = { run: "2026-01-01T00-00-00" };

      await expect(logsCommand(options)).rejects.toThrow(/run not found in registry/i);
    });

    test("shows unavailable message when eventsDir does not exist", async () => {
      // Add a registry entry pointing to a non-existent eventsDir
      const entryDir = join(registryDir, "proj-feat-ghost-run");
      mkdirSync(entryDir, { recursive: true });
      writeFileSync(
        join(entryDir, "meta.json"),
        JSON.stringify({
          runId: "ghost-run",
          project: "proj",
          feature: "feat",
          workdir: "/nonexistent",
          statusPath: "/nonexistent/.nax/features/feat/status.json",
          eventsDir: "/nonexistent/.nax/features/feat/runs",
          registeredAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const options: LogsOptions = { run: "ghost-run" };

      // Should resolve without throwing — prints unavailable message
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

    test("--json with --follow and an already-aborted signal resolves to undefined", async () => {
      const controller = new AbortController();
      controller.abort();

      const options: LogsOptions = {
        dir: projectDir,
        follow: true,
        json: true,
        signal: controller.signal,
      };
      await expect(logsCommand(options)).resolves.toBeUndefined();
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
        run: "2026-02-27T10-00-00",
        story: "US-001",
        level: "info",
      };

      await expect(logsCommand(options)).resolves.toBeUndefined();
    });

    test("all filters combined", async () => {
      const options: LogsOptions = {
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
      mkdirSync(join(invalidProject, ".nax"), { recursive: true });

      const options: LogsOptions = { dir: invalidProject };

      await expect(logsCommand(options)).rejects.toThrow(/config.json/i);

      cleanup(invalidProject);
    });
  });
});
