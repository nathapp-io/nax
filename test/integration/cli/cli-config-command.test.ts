// RE-ARCH: keep
/**
 * Config Command Integration Tests — Basic functionality, default view, and field descriptions
 *
 * Tests for `nax config` command core behavior.
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
});
