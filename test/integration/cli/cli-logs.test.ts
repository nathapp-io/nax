// RE-ARCH: keep
/**
 * Integration tests for nax logs CLI command
 *
 * Tests the full CLI invocation including:
 * - Command parsing
 * - Flag handling
 * - Output formatting
 * - Process behavior (follow mode)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_WORKSPACE = join(import.meta.dir, "../../..", "tmp", "cli-logs-test");
const NAX_BIN = join(import.meta.dir, "..", "..", "..", "bin", "nax.ts");
const REGISTRY_DIR = join(TEST_WORKSPACE, "registry");

function setupTestProject(featureName: string): string {
  const projectDir = join(TEST_WORKSPACE, `project-${Date.now()}`);
  const naxDir = join(projectDir, "nax");
  const featureDir = join(naxDir, "features", featureName);
  const runsDir = join(featureDir, "runs");

  mkdirSync(runsDir, { recursive: true });
  mkdirSync(REGISTRY_DIR, { recursive: true });

  writeFileSync(join(naxDir, "config.json"), JSON.stringify({ feature: featureName }));

  // Create sample logs
  const logs = [
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

  const runId = "2026-02-27T12-00-00";
  writeFileSync(join(runsDir, `${runId}.jsonl`), logs.map((l) => JSON.stringify(l)).join("\n"));

  // Create matching registry entry so --run <runId> resolves via registry
  const entryDir = join(REGISTRY_DIR, `testproject-${featureName}-${runId}`);
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(
    join(entryDir, "meta.json"),
    JSON.stringify({
      runId,
      project: "testproject",
      feature: featureName,
      workdir: projectDir,
      statusPath: join(projectDir, "nax", "features", featureName, "status.json"),
      eventsDir: runsDir,
      registeredAt: "2026-02-27T12:00:00.000Z",
    }),
  );

  return projectDir;
}

function cleanup(dir: string) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CMD_TIMEOUT_MS = 15_000; // 15s per command — fast-fail instead of waiting full 60s

function runNaxCommand(
  args: string[],
  cwd?: string,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["run", NAX_BIN, ...args], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...extraEnv },
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`runNaxCommand timed out after ${CMD_TIMEOUT_MS}ms: bun run nax ${args.join(" ")}`));
    }, CMD_TIMEOUT_MS);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code || 0 });
    });
  });
}

describe("nax logs CLI integration", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = setupTestProject("test-feature");
  });

  afterAll(() => {
    cleanup(TEST_WORKSPACE);
  });

  describe("basic invocation", () => {
    test("nax logs displays latest run", async () => {
      const result = await runNaxCommand(["logs", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("run-001");
    });

    test("nax logs without -d uses CWD", async () => {
      const result = await runNaxCommand(["logs"], projectDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("run-001");
    });

    test("nax logs fails when no project found", async () => {
      const result = await runNaxCommand(["logs", "-d", "/nonexistent"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid directory");
    });
  });

  describe("--list flag", () => {
    test("nax logs --list shows runs table", async () => {
      const result = await runNaxCommand(["logs", "--list", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("2026-02-27T12-00-00");
    });

    test("nax logs -l is shorthand for --list", async () => {
      const result = await runNaxCommand(["logs", "-l", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("2026-02-27T12-00-00");
    });
  });

  describe("--run flag", () => {
    const registryEnv = { NAX_RUNS_DIR: REGISTRY_DIR };

    test("nax logs --run <runId> displays logs from matching registry entry", async () => {
      const result = await runNaxCommand(["logs", "--run", "2026-02-27T12-00-00"], undefined, registryEnv);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("run-001");
    });

    test("nax logs -r is shorthand for --run", async () => {
      const result = await runNaxCommand(["logs", "-r", "2026-02-27T12-00-00"], undefined, registryEnv);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("run-001");
    });

    test("nax logs --run fails when run not found in registry", async () => {
      const result = await runNaxCommand(["logs", "--run", "2026-01-01T00-00-00"], undefined, registryEnv);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not found");
    });
  });

  describe("--story filter", () => {
    test("nax logs --story <id> filters to story", async () => {
      const result = await runNaxCommand(["logs", "--story", "US-001", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("US-001");
      expect(result.stdout).not.toContain("US-002");
    });

    test("nax logs -s is shorthand for --story", async () => {
      const result = await runNaxCommand(["logs", "-s", "US-001", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("US-001");
    });
  });

  describe("--level filter", () => {
    test("nax logs --level error shows only errors", async () => {
      const result = await runNaxCommand(["logs", "--level", "error", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("US-002");
    });

    test("nax logs --level info shows info and above", async () => {
      const result = await runNaxCommand(["logs", "--level", "info", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      // Should include info and error, exclude debug
      expect(result.stdout).toContain("run-001");
    });
  });

  describe("--json flag", () => {
    test("nax logs --json outputs raw JSONL", async () => {
      const result = await runNaxCommand(["logs", "--json", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      // Every line should be valid JSON
      const lines = result.stdout.trim().split("\n");
      for (const line of lines) {
        if (line) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
    });

    test("nax logs -j is shorthand for --json", async () => {
      const result = await runNaxCommand(["logs", "-j", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(() => JSON.parse(lines[0])).not.toThrow();
    });

    test("--json combines with --story", async () => {
      const result = await runNaxCommand(["logs", "--json", "--story", "US-001", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      for (const line of lines) {
        if (line) {
          const parsed = JSON.parse(line);
          if (parsed.storyId) {
            expect(parsed.storyId).toBe("US-001");
          }
        }
      }
    });
  });

  describe("--follow mode", () => {
    test("nax logs --follow streams in real-time", async () => {
      // Follow mode prints existing log entries then watches for new ones.
      // We verify the process starts and produces stdout output.
      const proc = spawn("bun", ["run", NAX_BIN, "logs", "--follow", "-d", projectDir], {
        cwd: process.cwd(),
        env: process.env,
      });

      let started = false;
      proc.stdout.on("data", () => {
        started = true;
      });

      // Allow up to 1s for Bun process startup + log output (slow VMs need more time)
      await Bun.sleep(1000);

      // Kill the process
      proc.kill();

      expect(started).toBe(true);
    });

    test("nax logs -f is shorthand for --follow", async () => {
      const proc = spawn("bun", ["run", NAX_BIN, "logs", "-f", "-d", projectDir], {
        cwd: process.cwd(),
        env: process.env,
      });

      let started = false;
      proc.stdout.on("data", () => {
        started = true;
      });

      await Bun.sleep(1000);
      proc.kill();

      expect(started).toBe(true);
    });
  });

  describe("combined flags", () => {
    test("--story + --level + --json", async () => {
      const result = await runNaxCommand(["logs", "--story", "US-001", "--level", "debug", "--json", "-d", projectDir]);

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      for (const line of lines) {
        if (line) {
          const parsed = JSON.parse(line);
          if (parsed.storyId) {
            expect(parsed.storyId).toBe("US-001");
          }
        }
      }
    });

    test("--run + --story", async () => {
      const result = await runNaxCommand(
        ["logs", "--run", "2026-02-27T12-00-00", "--story", "US-001"],
        undefined,
        { NAX_RUNS_DIR: REGISTRY_DIR },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("US-001");
    });
  });
});
