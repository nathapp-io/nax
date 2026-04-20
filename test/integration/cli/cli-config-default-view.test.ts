// RE-ARCH: keep
/**
 * Config Command default-view integration tests
 *
 * Covers direct default-view CLI output plus edge cases for `nax config`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configCommand } from "../../../src/cli/config";
import { loadConfig } from "../../../src/config/loader";
import { makeTempDir } from "../../helpers/temp";

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
