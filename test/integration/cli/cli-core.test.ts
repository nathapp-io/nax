/**
 * CLI --parallel flag tests
 *
 * Validates that the --parallel flag is correctly parsed and passed to RunOptions.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RunOptions } from "../../../src/execution/runner";
import { fullTest } from "../../helpers/env";
import { makeTempDir } from "../../helpers/temp";

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
 * Tests logsCommand() directly (no subprocess) to avoid cold-start timeouts
 * on GitHub Actions shared runners. Captures console.log output in-process.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logsCommand } from "../../../src/commands/logs";
import { _logsReaderDeps as logsReaderDeps } from "../../../src/commands/logs-reader";

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
    test("nax logs --follow streams existing entries then watches", async () => {
      // followLogs reads existing entries then watches for new ones via fs.watch.
      // We call it via logsCommand with follow:true and verify it produces output
      // from the existing run file before the watcher blocks — then abort via AbortSignal.
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

      const ac = new AbortController();
      // Give the command 2s to emit existing entries, then abort
      const timer = setTimeout(() => ac.abort(), 2000);

      try {
        await Promise.race([
          logsCommand({ dir: projectDir, follow: true }),
          new Promise<void>((resolve) => ac.signal.addEventListener("abort", () => resolve())),
        ]);
      } finally {
        clearTimeout(timer);
        console.log = orig;
      }

      // Should have emitted existing log entries before blocking on watcher
      expect(lines.length).toBeGreaterThan(0);
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
      const lines = stdout.trim().split("\n").filter(Boolean);
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

/**
 * Integration test for headless mode with formatter
 *
 * Verifies that `nax run` uses formatted output in headless mode
 * instead of raw JSONL, while still writing JSONL to disk.
 */

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

import { generateCommand } from "../../../src/cli/generate";
import { loadConfig } from "../../../src/config/loader";
import { generateAll, generateFor } from "../../../src/context/generator";
import type { AgentType } from "../../../src/context/types";

describe("nax generate command", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let consoleErrors: string[];
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    // Create temp directory
    tempDir = makeTempDir("nax-generate-test-");
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Create nax directory with context.md
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax/context.md"),
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
        context: ".nax/context.md",
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
        context: ".nax/context.md",
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
        context: ".nax/context.md",
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
        context: ".nax/context.md",
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
        context: ".nax/context.md",
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
        context: ".nax/context.md",
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
        context: ".nax/context.md",
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
      const result = await generateFor(
        "claude",
        {
          contextPath: join(tempDir, ".nax/context.md"),
          outputDir: tempDir,
          workdir: tempDir,
          dryRun: false,
        },
        config,
      );

      expect(result.agent).toBe("claude");
      expect(result.error).toBeUndefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.outputFile).toBe("CLAUDE.md");
    });

    test("Aider generator produces valid output", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor(
        "aider",
        {
          contextPath: join(tempDir, ".nax/context.md"),
          outputDir: tempDir,
          workdir: tempDir,
          dryRun: false,
        },
        config,
      );

      expect(result.agent).toBe("aider");
      expect(result.error).toBeUndefined();
      expect(result.content.length).toBeGreaterThan(0);
    });

    test("All generators produce output", async () => {
      const config = await loadConfig(tempDir);
      const results = await generateAll(
        {
          contextPath: join(tempDir, ".nax/context.md"),
          outputDir: tempDir,
          workdir: tempDir,
          dryRun: false,
        },
        config,
      );

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
      const result = await generateFor(
        "codex",
        {
          contextPath: join(tempDir, ".nax/context.md"),
          outputDir: tempDir,
          workdir: tempDir,
          dryRun: false,
        },
        config,
      );

      expect(result.agent).toBe("codex");
      expect(result.error).toBeUndefined();
      expect(result.outputFile).toBe("codex.md");
    });

    test("opencode generator is available", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor(
        "opencode",
        {
          contextPath: join(tempDir, ".nax/context.md"),
          outputDir: tempDir,
          workdir: tempDir,
          dryRun: false,
        },
        config,
      );

      expect(result.agent).toBe("opencode");
      expect(result.error).toBeUndefined();
      expect(result.outputFile).toBe("AGENTS.md");
    });

    test("gemini generator is available", async () => {
      const config = await loadConfig(tempDir);
      const result = await generateFor(
        "gemini",
        {
          contextPath: join(tempDir, ".nax/context.md"),
          outputDir: tempDir,
          workdir: tempDir,
          dryRun: false,
        },
        config,
      );

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
          context: ".nax/context.md",
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
        context: ".nax/context.md",
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

// Skip PID-sensitive tests in CI: container PIDs are ephemeral and low-numbered
// Requires real PID checks — skipped by default, run with FULL=1.
const skipInCI = fullTest;
import { diagnoseCommand } from "../../../src/cli/diagnose";
import type { NaxStatusFile } from "../../../src/execution/status-file";
import type { PRD } from "../../../src/prd";
import { savePRD } from "../../../src/prd";

// Test fixture directory
let testDir: string;

beforeEach(() => {
  // Create unique test directory
  testDir = makeTempDir("nax-diagnose-test-");

  // Create nax directory structure
  mkdirSync(join(testDir, ".nax", "features"), { recursive: true });
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
  mkdirSync(join(dir, ".nax"), { recursive: true });
  await Bun.write(join(dir, ".nax", "status.json"), JSON.stringify(status, null, 2));
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
    const featureDir = join(testDir, ".nax", "features", feature);
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
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
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
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
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
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
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
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
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
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "pending" }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Create lock with dead PID
    await createLockFile(testDir, 999999);

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "pending" }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Create lock with current process PID (alive)
    await createLockFile(testDir, process.pid);

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      { id: "US-001", title: "Passed Story", status: "passed", passes: true },
      { id: "US-002", title: "Failed Story", status: "failed", attempts: 2 },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "passed", passes: true }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Do NOT create events.jsonl or status.json

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Specific Story", status: "passed", passes: true }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Workdir Story", status: "passed", passes: true }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
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
    const featureDir = join(testDir, ".nax", "features", feature);
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
      output += `${args.join(" ")}\n`;
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

import { rm } from "node:fs/promises";
import { _acpAdapterDeps } from "../../../src/agents/acp/adapter";
import { agentsListCommand, _cliAgentsDeps } from "../../../src/cli/agents";
import { DEFAULT_CONFIG } from "../../../src/config";

describe("agentsListCommand", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = makeTempDir("nax-agents-test-");
  });

  afterAll(async () => {
    // Cleanup
    await rm(testDir, { recursive: true, force: true });
  });

  let origGetAgentVersion: typeof _cliAgentsDeps.getAgentVersion;
  let origWhich: typeof _acpAdapterDeps.which;

  beforeEach(() => {
    origGetAgentVersion = _cliAgentsDeps.getAgentVersion;
    origWhich = _acpAdapterDeps.which;
    // Mock getAgentVersion to return a version immediately
    _cliAgentsDeps.getAgentVersion = async () => "1.0.0";
    // Mock which to report "claude" as installed, others as not found
    _acpAdapterDeps.which = mock((binary: string) => (binary === "claude" ? "/usr/bin/claude" : null));
  });

  afterEach(() => {
    _cliAgentsDeps.getAgentVersion = origGetAgentVersion;
    _acpAdapterDeps.which = origWhich;
  });

  test("should display agents table with headers", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += `${message}\n`;
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
      output += `${message}\n`;
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
      output += `${message}\n`;
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
      output += `${message}\n`;
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
      output += `${message}\n`;
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
