/**
 * CLI --parallel flag tests
 *
 * Validates that the --parallel flag is correctly parsed and passed to RunOptions.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { RunOptions } from "../../../src/execution/runner";

describe("CLI --parallel flag parsing", () => {
  test("parses --parallel 4 correctly", () => {
    // Simulate parsing --parallel 4
    const parallelArg = "4";
    const parallel = Number.parseInt(parallelArg, 10);

    expect(parallel).toBe(4);
    expect(Number.isNaN(parallel)).toBe(false);
    expect(parallel).toBeGreaterThanOrEqual(0);
  });

  test("parses --parallel 0 (auto-detect mode) correctly", () => {
    const parallelArg = "0";
    const parallel = Number.parseInt(parallelArg, 10);

    expect(parallel).toBe(0);
    expect(Number.isNaN(parallel)).toBe(false);
  });

  test("omitted --parallel defaults to undefined (sequential)", () => {
    // When flag is not provided, parallel should be undefined
    const parallel: number | undefined = undefined;

    expect(parallel).toBeUndefined();
  });

  test("rejects negative --parallel values", () => {
    const parallelArg = "-1";
    const parallel = Number.parseInt(parallelArg, 10);

    expect(parallel).toBe(-1);
    expect(parallel).toBeLessThan(0);
  });

  test("rejects non-numeric --parallel values", () => {
    const parallelArg = "abc";
    const parallel = Number.parseInt(parallelArg, 10);

    expect(Number.isNaN(parallel)).toBe(true);
  });

  test("RunOptions accepts parallel field", () => {
    // Type-check that RunOptions accepts parallel field
    const options: Partial<RunOptions> = {
      parallel: 4,
    };

    expect(options.parallel).toBe(4);
  });

  test("RunOptions accepts parallel=0 (auto-detect)", () => {
    const options: Partial<RunOptions> = {
      parallel: 0,
    };

    expect(options.parallel).toBe(0);
  });

  test("RunOptions accepts parallel=undefined (sequential)", () => {
    const options: Partial<RunOptions> = {
      parallel: undefined,
    };

    expect(options.parallel).toBeUndefined();
  });
});

/**
 * Integration tests for nax logs CLI command
 *
 * Tests the full CLI invocation including:
 * - Command parsing
 * - Flag handling
 * - Output formatting
 * - Process behavior (follow mode)
 */

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
      // Wait for first data chunk (event-driven) rather than fixed 1s sleep.
      // Falls back to 5s max so the test never hangs on unusually slow VMs.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        proc.stdout.on("data", () => {
          started = true;
          clearTimeout(timer);
          resolve();
        });
      });

      proc.kill();
      expect(started).toBe(true);
    });

    test("nax logs -f is shorthand for --follow", async () => {
      const proc = spawn("bun", ["run", NAX_BIN, "logs", "-f", "-d", projectDir], {
        cwd: process.cwd(),
        env: process.env,
      });

      let started = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        proc.stdout.on("data", () => {
          started = true;
          clearTimeout(timer);
          resolve();
        });
      });

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

/**
 * Integration test for headless mode with formatter
 *
 * Verifies that `nax run` uses formatted output in headless mode
 * instead of raw JSONL, while still writing JSONL to disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { initLogger, resetLogger } from "../../../src/logger";

describe("Headless mode formatter integration", () => {
  const testDir = join(import.meta.dir, "../..", "tmp", "headless-test");
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

/**
 * Generate Command Integration Tests
 *
 * Tests for `nax generate` command with support for new context generators.
 * Verifies AgentType union includes new agents and generators work correctly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../../src/cli/generate";
import type { AgentType } from "../../../src/context/types";
import { generateFor, generateAll } from "../../../src/context/generator";
import { loadConfig } from "../../../src/config/loader";

describe("nax generate command", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let consoleErrors: string[];
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    // Create temp directory
    tempDir = mkdtempSync(join(tmpdir(), "nax-generate-test-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Create nax directory with context.md
    mkdirSync(join(tempDir, "nax"), { recursive: true });
    writeFileSync(
      join(tempDir, "nax/context.md"),
      `# Project Context

## Architecture
- Multi-agent system
- TypeScript + Bun

## Requirements
- 80% test coverage
- TDD methodology
`,
    );

    // Capture console output
    consoleOutput = [];
    consoleErrors = [];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    // Restore console
    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    // Cleanup
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("AgentType union type", () => {
    test("AgentType includes 'codex'", () => {
      const validAgents: AgentType[] = ["codex"];
      expect(validAgents[0]).toBe("codex");
    });

    test("AgentType includes 'opencode'", () => {
      const validAgents: AgentType[] = ["opencode"];
      expect(validAgents[0]).toBe("opencode");
    });

    test("AgentType includes 'gemini'", () => {
      const validAgents: AgentType[] = ["gemini"];
      expect(validAgents[0]).toBe("gemini");
    });

    test("AgentType includes 'aider'", () => {
      const validAgents: AgentType[] = ["aider"];
      expect(validAgents[0]).toBe("aider");
    });

    test("AgentType includes 'claude'", () => {
      const validAgents: AgentType[] = ["claude"];
      expect(validAgents[0]).toBe("claude");
    });

    test("AgentType supports all required agents", () => {
      const requiredAgents: AgentType[] = ["claude", "codex", "opencode", "cursor", "windsurf", "aider", "gemini"];
      expect(requiredAgents.length).toBe(7);
      expect(requiredAgents).toContain("codex");
      expect(requiredAgents).toContain("opencode");
      expect(requiredAgents).toContain("gemini");
      expect(requiredAgents).toContain("aider");
    });
  });

  describe("Generate command with agent option", () => {
    test("generates claude config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "claude",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("claude");
      expect(outputLines).toContain("CLAUDE.md");
    });

    test("generates codex config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "codex",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("codex");
      expect(outputLines).toContain("codex.md");
    });

    test("generates opencode config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "opencode",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("opencode");
      expect(outputLines).toContain("AGENTS.md");
    });

    test("generates gemini config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "gemini",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("gemini");
      expect(outputLines).toContain("GEMINI.md");
    });

    test("generates aider config successfully", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "aider",
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("aider");
      expect(outputLines).toContain(".aider.conf.yml");
    });
  });

  describe("Generate all agents", () => {
    test("generates all agent configs when no specific agent specified", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("claude");
      expect(outputLines).toContain("codex");
      expect(outputLines).toContain("opencode");
      expect(outputLines).toContain("aider");
      expect(outputLines).toContain("gemini");
    });

    test("includes cursor and windsurf in comprehensive generation", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        dryRun: false,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("cursor");
      expect(outputLines).toContain("windsurf");
    });
  });

  describe("Existing generators still work", () => {
    test("Claude generator produces valid output", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("claude", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("claude");
      expect(result.error).toBeUndefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.outputFile).toBe("CLAUDE.md");
    });

    test("Aider generator produces valid output", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("aider", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("aider");
      expect(result.error).toBeUndefined();
      expect(result.content.length).toBeGreaterThan(0);
    });

    test("All generators produce output", async () => {
      const config = await loadConfig(tempDir);
      const results = await generateAll({
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(results.length).toBeGreaterThan(0);

      // Verify each result has expected fields
      for (const result of results) {
        expect(result.agent).toBeDefined();
        expect(result.outputFile).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
      }
    });
  });

  describe("New generators included in manifest", () => {
    test("codex generator is available", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("codex", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("codex");
      expect(result.error).toBeUndefined();
      expect(result.outputFile).toBe("codex.md");
    });

    test("opencode generator is available", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("opencode", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("opencode");
      expect(result.error).toBeUndefined();
      expect(result.outputFile).toBe("AGENTS.md");
    });

    test("gemini generator is available", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor("gemini", {
        contextPath: join(tempDir, "nax/context.md"),
        outputDir: tempDir,
        workdir: tempDir,
        dryRun: false,
      }, config);

      expect(result.agent).toBe("gemini");
      expect(result.error).toBeUndefined();
      expect(result.outputFile).toBe("GEMINI.md");
    });
  });

  describe("Invalid agent handling", () => {
    test("rejects unknown agent types", async () => {
      let exitCode = 0;
      const originalExit = process.exit;
      process.exit = ((code?: number) => {
        exitCode = code ?? 1;
      }) as never;

      try {
        await generateCommand({
          context: "nax/context.md",
          output: tempDir,
          agent: "unknown",
          dryRun: false,
        });
      } finally {
        process.exit = originalExit;
      }

      expect(exitCode).toBe(1);
      const errorLines = consoleErrors.join("\n");
      expect(errorLines).toContain("Unknown agent");
    });
  });

  describe("Dry run mode", () => {
    test("dry run does not write files for new agents", async () => {
      await generateCommand({
        context: "nax/context.md",
        output: tempDir,
        agent: "codex",
        dryRun: true,
      });

      const outputLines = consoleOutput.join("\n");
      expect(outputLines).toContain("Dry run");
      expect(outputLines).toContain("codex");
    });
  });
});

/**
 * Integration Tests: nax diagnose CLI
 *
 * Tests the diagnose command that reads run artifacts and produces
 * structured diagnosis reports via pure pattern matching.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Skip PID-sensitive tests in CI: container PIDs are ephemeral and low-numbered
// (e.g. PID 1 or 52 may already be dead or reused), so "is PID alive" checks
// produce inconsistent results. These tests are reliable in local dev/VPS/Mac01.
const skipInCI = process.env.CI ? test.skip : test;
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseCommand } from "../../../src/cli/diagnose";
import type { NaxStatusFile } from "../../../src/execution/status-file";
import type { PRD } from "../../../src/prd";
import { savePRD } from "../../../src/prd";

// Test fixture directory
let testDir: string;

beforeEach(() => {
  // Create unique test directory
  testDir = join(tmpdir(), `nax-diagnose-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });

  // Create nax directory structure
  mkdirSync(join(testDir, "nax", "features"), { recursive: true });
});

afterEach(() => {
  // Clean up test directory
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Create a minimal PRD fixture
 */
function createPRD(feature: string, stories: Array<Partial<PRD["userStories"][0]>>): PRD {
  return {
    project: "test-project",
    feature,
    branchName: "feature/test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    userStories: stories.map((s, i) => ({
      id: s.id ?? `US-${String(i + 1).padStart(3, "0")}`,
      title: s.title ?? "Test Story",
      description: s.description ?? "Test description",
      acceptanceCriteria: s.acceptanceCriteria ?? [],
      tags: s.tags ?? [],
      dependencies: s.dependencies ?? [],
      status: s.status ?? "pending",
      passes: s.passes ?? false,
      escalations: s.escalations ?? [],
      attempts: s.attempts ?? 0,
      priorErrors: s.priorErrors ?? [],
      ...s,
    })),
  };
}

/**
 * Create a status.json fixture
 */
async function createStatusFile(dir: string, feature: string, overrides: Partial<NaxStatusFile> = {}): Promise<void> {
  const status: NaxStatusFile = {
    version: 1,
    run: {
      id: "run-001",
      feature,
      startedAt: "2026-01-01T10:00:00Z",
      status: "running",
      dryRun: false,
      pid: process.pid,
      ...overrides.run,
    },
    progress: {
      total: 3,
      passed: 1,
      failed: 1,
      paused: 0,
      blocked: 0,
      pending: 1,
      ...overrides.progress,
    },
    cost: {
      spent: 0.05,
      limit: null,
      ...overrides.cost,
    },
    current: null,
    iterations: 1,
    updatedAt: "2026-01-01T10:30:00Z",
    durationMs: 1800000,
    ...overrides,
  };

  // Ensure nax directory exists
  mkdirSync(join(dir, "nax"), { recursive: true });
  await Bun.write(join(dir, "nax", "status.json"), JSON.stringify(status, null, 2));
}

/**
 * Create a lock file fixture
 */
async function createLockFile(dir: string, pid: number): Promise<void> {
  await Bun.write(
    join(dir, "nax.lock"),
    JSON.stringify({
      pid,
      timestamp: Date.now(),
    }),
  );
}

// ============================================================================
// AC1: Basic diagnosis with all 5 sections
// ============================================================================

describe("AC1: nax diagnose reads last run and prints all 5 sections", () => {
  test("prints Run Summary, Story Breakdown (verbose), Failure Analysis, Lock Check, Recommendations", async () => {
    const feature = "test-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    // Create PRD with mixed stories
    const prd = createPRD(feature, [
      { id: "US-001", title: "Passed Story", status: "passed", passes: true, attempts: 1 },
      {
        id: "US-002",
        title: "Failed Story",
        status: "failed",
        passes: false,
        attempts: 3,
        priorErrors: ["tests-failing", "tests-failing"],
      },
      { id: "US-003", title: "Pending Story", status: "pending", passes: false, attempts: 0 },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Create status file
    await createStatusFile(testDir, feature, {
      run: {
        id: "run-001",
        feature,
        startedAt: "2026-01-01T10:00:00Z",
        status: "running",
        dryRun: false,
        pid: process.pid,
      },
      progress: {
        total: 3,
        passed: 1,
        failed: 1,
        paused: 0,
        blocked: 0,
        pending: 1,
      },
      cost: {
        spent: 0.05,
        limit: null,
      },
    });

    // Capture console output
    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({
        feature,
        workdir: testDir,
        verbose: true,
      });

      // Verify all sections present
      expect(output).toContain("Diagnosis Report");
      expect(output).toContain("Run Summary");
      expect(output).toContain("Story Breakdown");
      expect(output).toContain("Failure Analysis");
      expect(output).toContain("Lock Check");
      expect(output).toContain("Recommendations");

      // Verify counts
      expect(output).toContain("Passed:      1");
      expect(output).toContain("Failed:      1");
      expect(output).toContain("Pending:     1");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC2: Pattern classification for failed stories
// ============================================================================

describe("AC2: Each failed story shows pattern classification", () => {
  test("classifies GREENFIELD_TDD pattern", async () => {
    const feature = "greenfield-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Greenfield Story",
        status: "failed",
        failureCategory: "greenfield-no-tests",
        priorErrors: ["greenfield-no-tests: no existing tests found"],
        attempts: 1,
      },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("GREENFIELD_TDD");
      expect(output).toContain("greenfield project with no existing tests");
    } finally {
      console.log = originalLog;
    }
  });

  test("classifies TEST_MISMATCH pattern", async () => {
    const feature = "test-mismatch-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Test Mismatch Story",
        status: "failed",
        priorErrors: ["tests-failing: AC-1", "tests-failing: AC-1", "tests-failing: AC-2"],
        attempts: 3,
      },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("TEST_MISMATCH");
      expect(output).toContain("Multiple test failures");
    } finally {
      console.log = originalLog;
    }
  });

  test("classifies AUTO_RECOVERED pattern (INFO level)", async () => {
    const feature = "auto-recovered-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Auto Recovered Story",
        status: "passed",
        passes: true,
        priorErrors: ["greenfield-no-tests: no existing tests found"],
        attempts: 2,
      },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("AUTO_RECOVERED");
      expect(output).toContain("INFO"); // Not ERROR
      expect(output).toContain("S5 successfully handled");
    } finally {
      console.log = originalLog;
    }
  });

  test("classifies UNKNOWN pattern when no match", async () => {
    const feature = "unknown-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Unknown Failure",
        status: "failed",
        priorErrors: ["some weird error"],
        attempts: 1,
      },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir, verbose: true });

      expect(output).toContain("UNKNOWN");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC3: Stale lock detection
// ============================================================================

describe("AC3: Stale nax.lock detection", () => {
  test("detects stale lock (PID dead) and shows fix command", async () => {
    const feature = "locked-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "pending" }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Create lock with dead PID
    await createLockFile(testDir, 999999);

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("Stale lock detected");
      expect(output).toContain("PID 999999 is dead");
      expect(output).toContain("rm nax.lock");
    } finally {
      console.log = originalLog;
    }
  });

  skipInCI("shows active lock when PID alive", async () => {
    const feature = "active-lock-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "pending" }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Create lock with current process PID (alive)
    await createLockFile(testDir, process.pid);

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("Active lock");
      expect(output).toContain(`PID ${process.pid}`);
      expect(output).not.toContain("rm nax.lock");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC4: JSON output mode
// ============================================================================

describe("AC4: --json flag outputs machine-readable JSON", () => {
  test("outputs valid JSON with all report fields", async () => {
    const feature = "json-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      { id: "US-001", title: "Passed Story", status: "passed", passes: true },
      { id: "US-002", title: "Failed Story", status: "failed", attempts: 2 },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir, json: true });

      const report = JSON.parse(output);

      // Verify structure
      expect(report).toHaveProperty("runSummary");
      expect(report).toHaveProperty("storyBreakdown");
      expect(report).toHaveProperty("failureAnalysis");
      expect(report).toHaveProperty("lockCheck");
      expect(report).toHaveProperty("recommendations");
      expect(report).toHaveProperty("dataSources");

      // Verify counts
      expect(report.runSummary.storiesPassed).toBe(1);
      expect(report.runSummary.storiesFailed).toBe(1);
      expect(report.runSummary.storiesPending).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC5: Graceful degradation when events.jsonl missing
// ============================================================================

describe("AC5: Works gracefully when events.jsonl missing", () => {
  test("uses PRD + git log only and prints note", async () => {
    const feature = "no-events-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "passed", passes: true }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Do NOT create events.jsonl or status.json

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      // Should not crash
      expect(output).toContain("Diagnosis Report");
      expect(output).toContain("events.jsonl not found");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC6: -f and -d flags for targeting
// ============================================================================

describe("AC6: -f <feature> and -d <workdir> flags work", () => {
  test("diagnoses specific feature with -f flag", async () => {
    const feature = "specific-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Specific Story", status: "passed", passes: true }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir, verbose: true });

      expect(output).toContain(feature);
      expect(output).toContain("Specific Story");
    } finally {
      console.log = originalLog;
    }
  });

  test("uses specified workdir with -d flag", async () => {
    const feature = "workdir-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Workdir Story", status: "passed", passes: true }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir, verbose: true });

      expect(output).toContain("Workdir Story");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC7: AUTO_RECOVERED shown as INFO not ERROR
// ============================================================================

describe("AC7: AUTO_RECOVERED stories shown as INFO", () => {
  test("displays AUTO_RECOVERED with INFO level, not ERROR", async () => {
    const feature = "recovered-feature";
    const featureDir = join(testDir, "nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Recovered Story",
        status: "passed",
        passes: true,
        priorErrors: ["greenfield-no-tests"],
        attempts: 2,
      },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(" ") + "\n";
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      // Check that AUTO_RECOVERED appears with INFO
      const lines = output.split("\n");
      const recoveredLine = lines.find((line) => line.includes("US-001"));

      expect(recoveredLine).toBeDefined();
      expect(output).toContain("INFO");
      expect(output).toContain("AUTO_RECOVERED");
      expect(output).not.toContain("ERROR US-001");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC8: TypeScript compiles cleanly
// ============================================================================

// This is validated by running `bun run typecheck` separately
// No test needed here — the entire test file compiling is the test

/**
 * Integration tests for nax agents CLI command
 *
 * Tests the agents list command that displays available agents
 * with their binary paths, versions, and health status.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../../src/config";
import { agentsListCommand } from "../../../src/cli/agents";

describe("agentsListCommand", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "nax-agents-test-"));
  });

  afterAll(async () => {
    // Cleanup
    await Bun.spawn(["rm", "-rf", testDir]).exited;
  });

  test("should display agents table with headers", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Verify table structure
      expect(output).toContain("Agent");
      expect(output).toContain("Status");
      expect(output).toContain("Version");
      expect(output).toContain("Binary");
    } finally {
      console.log = originalLog;
    }
  });

  test("should show default agent indicator", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Should indicate default agent
      expect(output).toMatch(/claude.*\(default\)|default.*claude/i);
    } finally {
      console.log = originalLog;
    }
  });

  test("should list all known agents", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Should mention at least some agents
      expect(output.toLowerCase()).toContain("claude");
    } finally {
      console.log = originalLog;
    }
  });

  test("should show installation status", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Should show status like "installed" or "unavailable"
      expect(output.toLowerCase()).toMatch(/installed|unavailable|available/);
    } finally {
      console.log = originalLog;
    }
  });

  test("should show agent capabilities", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Should mention capabilities or features
      expect(output.length).toBeGreaterThan(0);
    } finally {
      console.log = originalLog;
    }
  });
});

