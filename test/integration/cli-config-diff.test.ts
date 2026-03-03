/**
 * Config Command --diff Flag Integration Tests
 *
 * Tests for `nax config --diff` command that shows only fields where
 * project config overrides the global config.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configCommand } from "../../src/cli/config";
import { loadConfig } from "../../src/config/loader";

describe("Config Command --diff", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;
  let originalProcessExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    // Create temp directory
    tempDir = mkdtempSync(join(tmpdir(), "nax-config-diff-test-"));
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        routing: {
          llm: {
            timeoutMs: 30000, // Different from default (15000)
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
      expect(output).toContain("30000");
      expect(output).toContain("15000");
    });

    test("shows field descriptions when available", async () => {
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
      mkdirSync(naxDir, { recursive: true });
      const projectConfig = {
        models: {
          fast: {
            provider: "openai",
            model: "gpt-4o-mini",
          },
        },
      };
      writeFileSync(join(naxDir, "config.json"), JSON.stringify(projectConfig, null, 2));

      process.chdir(tempDir);
      const config = await loadConfig(tempDir);

      await configCommand(config, { diff: true });

      const output = consoleOutput.join("\n");

      // Should show nested differences (provider and model fields)
      expect(output).toContain("models.fast.provider");
      expect(output).toContain("models.fast.model");
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
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
      const naxDir = join(tempDir, "nax");
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
