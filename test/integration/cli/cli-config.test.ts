// RE-ARCH: keep
/**
 * Config Command Integration Tests
 *
 * Tests for `nax config` command with --explain flag.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configCommand } from "../../../src/cli/config";
import { loadConfig } from "../../../src/config/loader";
import { makeTempDir } from "../../helpers/temp";

describe("Config Command", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    // Create temp directory
    tempDir = makeTempDir("nax-config-test-");
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
      expect(output).toContain("# Per-agent model map");
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
      const naxDir = join(tempDir, ".nax");
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

      expect(output).toContain("# Per-agent model map");
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

      expect(output).toContain("Enable automatic agent selection and escalation");
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
      const naxDir = join(tempDir, ".nax");
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

      // Models have string values in per-agent structure
      expect(output).toMatch(/fast: "haiku"|balanced: "sonnet"|powerful: "opus"/);
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
      // adaptive removed in ROUTE-001
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
      const naxDir = join(tempDir, ".nax");
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
      const naxDir = join(tempDir, ".nax");
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
      const naxDir = join(tempDir, ".nax");
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
      const naxDir = join(tempDir, ".nax");
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
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          routing: {
            llm: {
              timeoutMs: 60000,
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
      expect(output).toContain("60000");
    });

    test("handles array differences", async () => {
      // Create project config with array overrides
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(
        join(naxDir, "config.json"),
        JSON.stringify({
          agent: {
            fallback: {
              map: { codex: ["claude"], claude: ["codex"] },
            },
          },
        }),
      );

      process.chdir(tempDir);

      const config = await loadConfig();
      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show nested object field
      expect(output).toContain("agent.fallback.map");
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
/**
 * Config Command --diff Flag Integration Tests
 *
 * Tests for `nax config --diff` command that shows only fields where
 * project config overrides the global config.
 */

describe("Config Command --diff", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;
  let originalProcessExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    // Create temp directory
    tempDir = makeTempDir("nax-config-diff-test-");
    originalCwd = process.cwd();

    // Capture console output
    consoleOutput = [];
    originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };

    // Mock process.exit to capture exit code
    exitCode = undefined;
    originalProcessExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    // Restore console and process.exit
    console.log = originalConsoleLog;
    process.exit = originalProcessExit;

    // Cleanup
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("No project config", () => {
    test("shows 'No project config found' when no nax/config.json exists", async () => {
      // Set up: no project config, just load defaults
      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      // Run with --diff
      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");
      expect(output).toContain("No project config found — using global defaults");
    });

    test("shows 'No project config found' when nax/ dir exists but config.json doesn't", async () => {
      // Create nax/ dir but no config.json
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");
      expect(output).toContain("No project config found — using global defaults");
    });
  });

  describe("Project config exists but identical to global", () => {
    test("shows 'No differences' when project config matches global", async () => {
      // Create empty project config (should merge to same as global)
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), JSON.stringify({}));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");
      expect(output).toContain("No differences between project and global config");
    });
  });

  describe("Project config overrides global", () => {
    test("shows table with field path, project value, and global value", async () => {
      // Create project config with a simple override
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        execution: {
          maxIterations: 25, // Different from any global value
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show header
      expect(output).toContain("# Config Differences (Project overrides Global)");

      // Should show table separator
      expect(output).toContain("─");

      // Should show column headers
      expect(output).toContain("Field");
      expect(output).toContain("Project Value");
      expect(output).toContain("Global Value");

      // Should show the specific field
      expect(output).toContain("execution.maxIterations");

      // Should show project value (25)
      expect(output).toContain("25");

      // Global value will vary based on ~/.nax/config.json, just verify it's present
      // The key assertion is that we show both values in a diff
      const lines = output.split("\n");
      const maxIterLine = lines.find((line) => line.includes("execution.maxIterations"));
      expect(maxIterLine).toBeDefined();
    });

    test("shows multiple differences when multiple fields override", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        execution: {
          maxIterations: 25,
          costLimit: 10.0,
        },
        tdd: {
          maxRetries: 5,
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show all three differences
      expect(output).toContain("execution.maxIterations");
      expect(output).toContain("execution.costLimit");
      expect(output).toContain("tdd.maxRetries");

      // Check project values are present
      expect(output).toContain("25"); // maxIterations project
      expect(output).toContain("10"); // costLimit project
      expect(output).toContain("5"); // tdd.maxRetries project

      // Verify table structure exists
      const lines = output.split("\n");
      expect(lines.some((line) => line.includes("execution.maxIterations"))).toBe(true);
      expect(lines.some((line) => line.includes("execution.costLimit"))).toBe(true);
      expect(lines.some((line) => line.includes("tdd.maxRetries"))).toBe(true);
    });

    test("shows nested field paths correctly", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        routing: {
          llm: {
            timeoutMs: 60000, // Different from default (30000)
          },
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show nested path
      expect(output).toContain("routing.llm.timeoutMs");
      expect(output).toContain("60000");
      expect(output).toContain("30000");
    });

    test("shows field descriptions when available", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        execution: {
          maxIterations: 25,
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show description for execution.maxIterations
      // Description: "Max iterations per feature run (auto-calculated if not set)"
      expect(output).toContain("Max iterations per feature run");
    });

    test("handles array differences correctly", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        quality: {
          stripEnvVars: ["CUSTOM_VAR", "ANOTHER_VAR"], // Different from default
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show the field
      expect(output).toContain("quality.stripEnvVars");

      // Arrays should be formatted compactly for table
      expect(output).toContain("[..."); // Compact array notation
    });

    test("handles boolean differences correctly", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        quality: {
          requireTests: false, // Different from default/global (true)
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("quality.requireTests");
      expect(output).toContain("false");
      expect(output).toContain("true");
    });

    test("handles string value differences correctly", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        routing: {
          strategy: "manual", // Use "manual" to ensure it's different from any global
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("routing.strategy");
      expect(output).toContain('"manual"'); // Project value
      // Global value will vary, just verify the field is shown
    });

    test("truncates long string values in table", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        constitution: {
          path: "very-long-constitution-filename-that-should-be-truncated.md",
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      expect(output).toContain("constitution.path");
      // Long strings should be truncated with "..."
      expect(output).toMatch(/\.\.\./);
    });

    test("handles object differences correctly", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        models: {
          claude: {
            fast: "gpt-4o-mini",
          },
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show nested differences (per-agent tier field)
      expect(output).toContain("models.claude.fast");
    });
  });

  describe("Mutual exclusivity with --explain", () => {
    test("rejects when both --diff and --explain are provided", async () => {
      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      // Attempt to use both flags
      let didThrow = false;
      try {
        await configCommand(config, { diff: true, explain: true });
      } catch (err) {
        didThrow = true;
        expect(String(err)).toContain("process.exit(1)");
      }

      expect(didThrow).toBe(true);
      expect(exitCode).toBe(1);
    });

    test("shows error message when both flags provided", async () => {
      // Capture console.error as well
      const errorOutput: string[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        errorOutput.push(args.map((a) => String(a)).join(" "));
      };

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      try {
        await configCommand(config, { diff: true, explain: true });
      } catch {
        // Expected to throw
      }

      console.error = originalConsoleError;

      const errorMsg = errorOutput.join("\n");
      expect(errorMsg).toContain("--explain and --diff are mutually exclusive");
    });
  });

  describe("Edge cases", () => {
    test("handles null values in diff correctly", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        execution: {
          lintCommand: null, // Explicitly disable
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show the difference if global has undefined and project has null
      // (depends on how deepDiffConfigs handles null vs undefined)
      // This test verifies the function doesn't crash
      expect(output).toBeDefined();
    });

    test("skips fields that are only in global (not overridden)", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        execution: {
          maxIterations: 25, // Only override this one field
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should only show execution.maxIterations
      expect(output).toContain("execution.maxIterations");

      // Should NOT show other execution fields that weren't overridden
      expect(output).not.toContain("execution.costLimit");
      expect(output).not.toContain("execution.sessionTimeoutSeconds");
    });

    test("handles deeply nested config overrides", async () => {
      const naxDir = join(tempDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        autoMode: {
          escalation: {
            tierOrder: [
              { tier: "fast", attempts: 3 },
              { tier: "balanced", attempts: 2 },
            ],
          },
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show the nested field
      expect(output).toContain("autoMode.escalation.tierOrder");
    });
  });
});

/**
 * CLI Integration Tests for `nax config` Default View
 *
 * Tests the full end-to-end flow of running `nax config` without flags
 * via the CLI entry point (bin/nax.ts).
 */

/**
 * Capture console.log/error while running configCommand directly (no subprocess).
 * Caller must process.chdir(cwd) before calling — loadConfig() uses process.cwd()
 * via findProjectDir() which walks up looking for .nax/config.json.
 */
async function captureConfigCommand(_cwd: string): Promise<{ stdout: string; stderr: string; error?: Error }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => outLines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errLines.push(args.map(String).join(" "));
  try {
    // No arg: findProjectDir() uses process.cwd() (already chdir'd by caller)
    const config = await loadConfig();
    await configCommand(config);
    return { stdout: outLines.join("\n"), stderr: errLines.join("\n") };
  } catch (err) {
    return { stdout: outLines.join("\n"), stderr: errLines.join("\n"), error: err as Error };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("nax config (default view) - CLI integration", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-config-cli-test-");
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("prints effective merged config as JSON with header", async () => {
    process.chdir(tempDir);
    const { stdout, error } = await captureConfigCommand(tempDir);
    expect(error).toBeUndefined();

    expect(stdout).toContain("// nax Configuration");
    expect(stdout).toContain("// Resolution order: defaults → global → project → CLI overrides");
    expect(stdout).toContain("// Global config:");
    expect(stdout).toContain("// Project config:");

    const lines = stdout.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    expect(jsonStartIndex).toBeGreaterThan(0);

    const jsonOutput = lines.slice(jsonStartIndex).join("\n");
    expect(() => JSON.parse(jsonOutput)).not.toThrow();

    const parsed = JSON.parse(jsonOutput);
    expect(parsed.version).toBe(1);
    expect(parsed.models).toBeDefined();
    expect(parsed.autoMode).toBeDefined();
    expect(parsed.execution).toBeDefined();
  });

  test("shows global config path in header", async () => {
    process.chdir(tempDir);
    const { stdout, error } = await captureConfigCommand(tempDir);
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Global config:");
  });

  test("shows (not found) for missing project config", async () => {
    const isolatedDir = join(tempDir, "isolated");
    mkdirSync(isolatedDir, { recursive: true });
    process.chdir(isolatedDir);
    const { stdout, error } = await captureConfigCommand(isolatedDir);
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Project config: (not found)");
  });

  test("shows project config path when present", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({ execution: { maxIterations: 20 } }));

    process.chdir(tempDir);
    const { stdout, error } = await captureConfigCommand(tempDir);
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Project config:");
    expect(stdout).toContain("config.json");

    const lines = stdout.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const parsed = JSON.parse(lines.slice(jsonStartIndex).join("\n"));
    expect(parsed.execution.maxIterations).toBe(20);
  });

  test("header precedes JSON output with blank line", async () => {
    process.chdir(tempDir);
    const { stdout, error } = await captureConfigCommand(tempDir);
    expect(error).toBeUndefined();

    const lines = stdout.split("\n");
    const headerLineIndex = lines.findIndex((line) => line.includes("// nax Configuration"));
    const jsonLineIndex = lines.findIndex((line) => line.startsWith("{"));

    expect(headerLineIndex).toBeGreaterThanOrEqual(0);
    expect(jsonLineIndex).toBeGreaterThan(headerLineIndex);
    expect(lines[jsonLineIndex - 1]).toBe("");
  });

  test("JSON output is pretty-printed (indented)", async () => {
    process.chdir(tempDir);
    const { stdout, error } = await captureConfigCommand(tempDir);
    expect(error).toBeUndefined();
    expect(stdout).toMatch(/"version": 1/);
    expect(stdout).toMatch(/"models": \{/);
    expect(stdout).toContain("  ");
  });

  test("works when run from project subdirectory", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({ execution: { maxIterations: 30 } }));

    const subdir = join(tempDir, "src", "components");
    mkdirSync(subdir, { recursive: true });
    process.chdir(subdir);

    const { stdout, error } = await captureConfigCommand(subdir);
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Project config:");
    expect(stdout).toContain("config.json");

    const lines = stdout.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const parsed = JSON.parse(lines.slice(jsonStartIndex).join("\n"));
    expect(parsed.execution.maxIterations).toBe(30);
  });
});

/**
 * Edge Case Tests for `nax config` Default View
 *
 * Tests edge cases and regression scenarios for the default view.
 * These tests ensure the feature handles unusual scenarios correctly.
 */

describe("nax config (default view) - edge cases", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-config-edge-test-");
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("handles project config with only comments (valid but empty JSON)", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    process.chdir(tempDir);
    const { stdout, error } = await captureConfigCommand(tempDir);
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Project config:");
    expect(stdout).toContain("config.json");

    const lines = stdout.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const parsed = JSON.parse(lines.slice(jsonStartIndex).join("\n"));
    expect(parsed.version).toBe(1);
  });

  test("handles deep nesting when walking up directory tree", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({ execution: { maxIterations: 50 } }));

    const deepDir = join(tempDir, "a", "b", "c", "d", "e", "f");
    mkdirSync(deepDir, { recursive: true });
    process.chdir(deepDir);

    const { stdout, error } = await captureConfigCommand(deepDir);
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Project config:");
    expect(stdout).toContain("config.json");

    const lines = stdout.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const parsed = JSON.parse(lines.slice(jsonStartIndex).join("\n"));
    expect(parsed.execution.maxIterations).toBe(50);
  });

  test("outputs complete config structure with all top-level keys", async () => {
    process.chdir(tempDir);
    const { stdout, error } = await captureConfigCommand(tempDir);
    expect(error).toBeUndefined();

    const lines = stdout.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const parsed = JSON.parse(lines.slice(jsonStartIndex).join("\n"));

    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("models");
    expect(parsed).toHaveProperty("autoMode");
    expect(parsed).toHaveProperty("routing");
    expect(parsed).toHaveProperty("execution");
    expect(parsed).toHaveProperty("quality");
    expect(parsed).toHaveProperty("tdd");
    expect(parsed).toHaveProperty("constitution");
    expect(parsed).toHaveProperty("review");
    expect(parsed).toHaveProperty("plan");
    expect(parsed).toHaveProperty("acceptance");
    expect(parsed).toHaveProperty("context");
    expect(parsed).toHaveProperty("interaction");
    expect(parsed).toHaveProperty("precheck");
  });

  test("merges nested config overrides correctly", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(
      join(naxDir, "config.json"),
      JSON.stringify({ execution: { maxIterations: 15, rectification: { enabled: false, maxRetries: 5 } } }),
    );

    process.chdir(tempDir);
    const { stdout, error } = await captureConfigCommand(tempDir);
    expect(error).toBeUndefined();

    const lines = stdout.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const parsed = JSON.parse(lines.slice(jsonStartIndex).join("\n"));

    expect(parsed.execution.maxIterations).toBe(15);
    expect(parsed.execution.rectification.enabled).toBe(false);
    expect(parsed.execution.rectification.maxRetries).toBe(5);
    expect(parsed.execution.iterationDelayMs).toBeDefined();
    expect(parsed.execution.rectification.fullSuiteTimeoutSeconds).toBeDefined();
  });

  test("handles project config with schema version mismatch", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({ version: 999, execution: { maxIterations: 25 } }));

    process.chdir(tempDir);
    const { stdout, stderr, error } = await captureConfigCommand(tempDir);

    // Should either succeed or fail gracefully — no unhandled crash
    if (error) {
      expect(error.message.toLowerCase()).toMatch(/error|invalid|version/);
    } else {
      const combined = stdout + stderr;
      if (combined.toLowerCase().includes("error")) {
        expect(combined.toLowerCase()).toMatch(/error|invalid|version/);
      } else {
        const lines = stdout.split("\n");
        const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
        expect(jsonStartIndex).toBeGreaterThan(0);
        expect(() => JSON.parse(lines.slice(jsonStartIndex).join("\n"))).not.toThrow();
      }
    }
  });
});
