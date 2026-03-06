/**
 * Config Command Integration Tests
 *
 * Tests for `nax config` command with --explain flag.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configCommand } from "../../../src/cli/config";
import { loadConfig } from "../../../src/config/loader";

describe("Config Command", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    // Create temp directory
    tempDir = mkdtempSync(join(tmpdir(), "nax-config-test-"));
    originalCwd = process.cwd();

    // Capture console output
    consoleOutput = [];
    originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    // Restore console
    console.log = originalConsoleLog;

    // Cleanup
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Basic functionality", () => {
    test("displays config as JSON when explain=false", async () => {
      // Load default config
      const config = await loadConfig(tempDir);

      // Run command without explain
      await configCommand(config, { explain: false });

      // Should output valid JSON (after the header lines)
      const output = consoleOutput.join("\n");

      // Find where JSON starts (after header comments and blank line)
      const lines = output.split("\n");
      const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
      expect(jsonStartIndex).toBeGreaterThan(0);

      const jsonOutput = lines.slice(jsonStartIndex).join("\n");
      expect(() => JSON.parse(jsonOutput)).not.toThrow();

      const parsed = JSON.parse(jsonOutput);
      expect(parsed.version).toBe(1);
      expect(parsed.models).toBeDefined();
    });

    test("displays config with explanations when explain=true", async () => {
      // Load default config
      const config = await loadConfig(tempDir);

      // Run command with explain
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      // Should have header
      expect(output).toContain("# nax Configuration");
      expect(output).toContain("# Resolution order: defaults → global → project → CLI overrides");

      // Should have field descriptions
      expect(output).toContain("# Configuration schema version");
      expect(output).toContain("# Model tier definitions");
      expect(output).toContain("# Auto mode configuration");
    });
  });

  describe("Default view (without --explain)", () => {
    test("shows header with config sources", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: false });

      const output = consoleOutput.join("\n");

      // Should have header comments
      expect(output).toContain("// nax Configuration");
      expect(output).toContain("// Resolution order: defaults → global → project → CLI overrides");
      expect(output).toContain("// Global config:");
      expect(output).toContain("// Project config:");
    });

    test("shows global config path when found", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: false });

      const output = consoleOutput.join("\n");

      // Global config path is in the output
      expect(output).toContain("// Global config:");
    });

    test("shows (not found) for missing project config", async () => {
      // Use an isolated directory without nax/config.json
      const isolatedDir = join(tempDir, "isolated");
      mkdirSync(isolatedDir, { recursive: true });
      process.chdir(isolatedDir);

      const config = await loadConfig(isolatedDir);
      await configCommand(config, { explain: false });

      const output = consoleOutput.join("\n");

      // Project config should show as not found in the isolated directory
      expect(output).toContain("// Project config: (not found)");
    });

    test("shows project config path when present", async () => {
      // Create project config
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          execution: {
            maxIterations: 20,
          },
        }),
      );

      process.chdir(tempDir);

      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: false });

      const output = consoleOutput.join("\n");

      // Should show project config path
      expect(output).toContain("// Project config:");
      expect(output).toContain("config.json");
    });

    test("header precedes JSON output", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: false });

      const output = consoleOutput.join("\n");
      const lines = output.split("\n");

      // Find header and JSON start
      const headerLineIndex = lines.findIndex((line) => line.includes("// nax Configuration"));
      const jsonLineIndex = lines.findIndex((line) => line.startsWith("{"));

      expect(headerLineIndex).toBeGreaterThanOrEqual(0);
      expect(jsonLineIndex).toBeGreaterThan(headerLineIndex);

      // Should have blank line between header and JSON
      expect(lines[jsonLineIndex - 1]).toBe("");
    });
  });

  describe("Field descriptions", () => {
    test("includes descriptions for top-level sections", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("# Model tier definitions");
      expect(output).toContain("# Auto mode configuration");
      expect(output).toContain("# Model routing strategy");
      expect(output).toContain("# Execution limits");
      expect(output).toContain("# Quality gate configuration");
      expect(output).toContain("# Test-driven development configuration");
    });

    test("includes descriptions for nested fields", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("# Enable automatic agent selection");
      expect(output).toContain("# Max iterations per feature run");
      expect(output).toContain("# Require typecheck to pass");
      expect(output).toContain("# TDD strategy: auto | strict | lite | off");
    });

    test("includes descriptions for deeply nested fields", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("# Enable tier escalation on failure");
      expect(output).toContain("# Model tier for test-writer session");
      expect(output).toContain("# Enable test coverage context injection");
    });
  });

  describe("Source annotations", () => {
    test("shows global config path when present", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      // Should show global config line (may be "not found" or a path)
      expect(output).toContain("# Global config:");
    });

    test("shows project config path when present", async () => {
      // Create project config
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          execution: {
            maxIterations: 20,
          },
        }),
      );

      process.chdir(tempDir);

      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      // Should show project config path
      expect(output).toContain("# Project config:");
      expect(output).toContain("config.json");
    });

    test('shows "(not found)" when no project config exists', async () => {
      // Use a directory without nax/config.json
      const isolatedDir = join(tempDir, "isolated");
      mkdirSync(isolatedDir, { recursive: true });
      process.chdir(isolatedDir);

      const config = await loadConfig(isolatedDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("# Project config: (not found)");
    });
  });

  describe("Value formatting", () => {
    test("formats strings with quotes", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      // Models have string values
      expect(output).toMatch(/model: "haiku"|model: "sonnet"|model: "opus"/);
    });

    test("formats booleans without quotes", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("enabled: true");
    });

    test("formats numbers without quotes", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("version: 1");
      expect(output).toMatch(/maxIterations: \d+/);
    });

    test("formats arrays compactly", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      // Should format small arrays inline
      expect(output).toMatch(/fallbackOrder: \[/);
    });

    test("truncates long arrays", async () => {
      const config = await loadConfig(tempDir);

      // Override with a long array
      config.quality.stripEnvVars = ["VAR1", "VAR2", "VAR3", "VAR4", "VAR5"];

      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      // Should show truncation for arrays > 3 items
      expect(output).toMatch(/stripEnvVars:.*\.\.\./);
    });
  });

  describe("All config sections", () => {
    test("covers models section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("models:");
      expect(output).toContain("fast:");
      expect(output).toContain("balanced:");
      expect(output).toContain("powerful:");
    });

    test("covers autoMode section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("autoMode:");
      expect(output).toContain("enabled:");
      expect(output).toContain("defaultAgent:");
      expect(output).toContain("complexityRouting:");
      expect(output).toContain("escalation:");
    });

    test("covers routing section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("routing:");
      expect(output).toContain("strategy:");
      expect(output).toContain("adaptive:");
      expect(output).toContain("llm:");
    });

    test("covers execution section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("execution:");
      expect(output).toContain("maxIterations:");
      expect(output).toContain("rectification:");
      expect(output).toContain("regressionGate:");
    });

    test("covers quality section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("quality:");
      expect(output).toContain("requireTypecheck:");
      expect(output).toContain("requireLint:");
      expect(output).toContain("requireTests:");
    });

    test("covers tdd section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("tdd:");
      expect(output).toContain("strategy:");
      expect(output).toContain("sessionTiers:");
    });

    test("covers constitution section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("constitution:");
      expect(output).toContain("enabled:");
      expect(output).toContain("path:");
    });

    test("covers analyze section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("analyze:");
      expect(output).toContain("llmEnhanced:");
      expect(output).toContain("model:");
    });

    test("covers review section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("review:");
      expect(output).toContain("enabled:");
      expect(output).toContain("checks:");
    });

    test("covers plan section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("plan:");
      expect(output).toContain("model:");
      expect(output).toContain("outputPath:");
    });

    test("covers acceptance section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("acceptance:");
      expect(output).toContain("enabled:");
      expect(output).toContain("generateTests:");
    });

    test("covers context section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("context:");
      expect(output).toContain("testCoverage:");
      expect(output).toContain("autoDetect:");
    });

    test("covers interaction section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("interaction:");
      expect(output).toContain("plugin:");
      expect(output).toContain("defaults:");
    });

    test("covers precheck section", async () => {
      const config = await loadConfig(tempDir);
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("precheck:");
      expect(output).toContain("storySizeGate:");
    });
  });

  describe("Works from any directory", () => {
    test("works when run from project root", async () => {
      // Create project config
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          execution: {
            maxIterations: 25,
          },
        }),
      );

      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("# nax Configuration");
      expect(output).toContain("maxIterations: 25");
    });

    test("works when run from subdirectory", async () => {
      // Create project config
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          execution: {
            maxIterations: 30,
          },
        }),
      );

      // Create subdirectory
      const subdir = join(tempDir, "src", "components");
      mkdirSync(subdir, { recursive: true });
      process.chdir(subdir);

      const config = await loadConfig();
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("# nax Configuration");
      expect(output).toContain("maxIterations: 30");
    });

    test("works when no project config exists", async () => {
      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { explain: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("# nax Configuration");
      expect(output).toContain("# Project config: (not found)");
    });
  });

  describe("Diff mode (--diff)", () => {
    test("shows message when no project config exists", async () => {
      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("No project config found — using global defaults");
    });

    test("shows message when project config has no differences", async () => {
      // Create empty project config
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), JSON.stringify({}));

      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("No differences between project and global config");
    });

    test("shows differences in table format", async () => {
      // Create project config with overrides
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          execution: {
            maxIterations: 25,
            costLimit: 10.0,
          },
        }),
      );

      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show header
      expect(output).toContain("# Config Differences (Project overrides Global)");

      // Should show table with field, project value, global value
      expect(output).toContain("Field");
      expect(output).toContain("Project Value");
      expect(output).toContain("Global Value");

      // Should show the specific differences
      expect(output).toContain("execution.maxIterations");
      expect(output).toContain("25");
      expect(output).toContain("execution.costLimit");
      expect(output).toContain("10");
    });

    test("shows field descriptions for differences", async () => {
      // Create project config with overrides
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          execution: {
            maxIterations: 25,
          },
        }),
      );

      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show description for the field
      expect(output).toContain("↳ Max iterations per feature run");
    });

    test("only shows fields that differ", async () => {
      // Create project config with overrides
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          execution: {
            maxIterations: 25,
          },
        }),
      );

      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show maxIterations
      expect(output).toContain("execution.maxIterations");

      // Should NOT show fields that aren't overridden
      expect(output).not.toContain("execution.iterationDelayMs");
      expect(output).not.toContain("quality.requireTypecheck");
      expect(output).not.toContain("models.fast");
    });

    test("handles nested object differences", async () => {
      // Create project config with nested overrides
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          routing: {
            llm: {
              timeoutMs: 30000,
            },
          },
        }),
      );

      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show nested field path
      expect(output).toContain("routing.llm.timeoutMs");
      expect(output).toContain("30000");
    });

    test("handles array differences", async () => {
      // Create project config with array overrides
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          autoMode: {
            fallbackOrder: ["codex", "claude"],
          },
        }),
      );

      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show array field
      expect(output).toContain("autoMode.fallbackOrder");
      expect(output).toContain("[...2]"); // Compact array format
    });

    test("mutually exclusive with --explain", async () => {
      // Capture console.error
      const consoleErrors: string[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        consoleErrors.push(args.map((a) => String(a)).join(" "));
      };

      // Mock process.exit to prevent test exit
      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCode = code;
      }) as typeof process.exit;

      try {
        const config = await loadConfig();
        await configCommand(config, { explain: true, diff: true });

        expect(exitCode).toBe(1);
        expect(consoleErrors.join("\n")).toContain("--explain and --diff are mutually exclusive");
      } finally {
        console.error = originalConsoleError;
        process.exit = originalExit;
      }
    });
  });
});
