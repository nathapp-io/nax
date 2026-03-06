// RE-ARCH: keep
/**
 * Edge Case Tests for `nax config` Default View
 *
 * Tests edge cases and regression scenarios for the default view.
 * These tests ensure the feature handles unusual scenarios correctly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("nax config (default view) - edge cases", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-config-edge-test-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  // NOTE: Error handling tests removed - those belong in a separate error handling story
  // The current story (CM-003) focuses on the happy path: displaying config when files are valid

  test("handles project config with only comments (valid but empty JSON)", async () => {
    // Create project config with only {}
    const naxDir = join(tempDir, "nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should show project config as found (even though it's empty)
    expect(output).toContain("// Project config:");
    expect(output).toContain("config.json");

    // Should still output valid JSON (merged with defaults)
    const lines = output.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const jsonOutput = lines.slice(jsonStartIndex).join("\n");
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.version).toBe(1);
  });

  test("handles deep nesting when walking up directory tree", async () => {
    // Create project config at root
    const naxDir = join(tempDir, "nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(
      join(naxDir, "config.json"),
      JSON.stringify({
        execution: {
          maxIterations: 50,
        },
      }),
    );

    // Create deeply nested subdirectory
    const deepDir = join(tempDir, "a", "b", "c", "d", "e", "f");
    mkdirSync(deepDir, { recursive: true });
    process.chdir(deepDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: deepDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should find project config by walking up
    expect(output).toContain("// Project config:");
    expect(output).toContain("config.json");

    // Should reflect merged config
    const lines = output.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const jsonOutput = lines.slice(jsonStartIndex).join("\n");
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.execution.maxIterations).toBe(50);
  });

  test("outputs complete config structure with all top-level keys", async () => {
    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    const lines = output.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const jsonOutput = lines.slice(jsonStartIndex).join("\n");
    const parsed = JSON.parse(jsonOutput);

    // Verify all required top-level keys are present
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("models");
    expect(parsed).toHaveProperty("autoMode");
    expect(parsed).toHaveProperty("routing");
    expect(parsed).toHaveProperty("execution");
    expect(parsed).toHaveProperty("quality");
    expect(parsed).toHaveProperty("tdd");
    expect(parsed).toHaveProperty("constitution");
    expect(parsed).toHaveProperty("analyze");
    expect(parsed).toHaveProperty("review");
    expect(parsed).toHaveProperty("plan");
    expect(parsed).toHaveProperty("acceptance");
    expect(parsed).toHaveProperty("context");
    expect(parsed).toHaveProperty("interaction");
    expect(parsed).toHaveProperty("precheck");
  });

  test("merges nested config overrides correctly", async () => {
    // Create project config with nested overrides
    const naxDir = join(tempDir, "nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(
      join(naxDir, "config.json"),
      JSON.stringify({
        execution: {
          maxIterations: 15,
          rectification: {
            enabled: false,
            maxRetries: 5,
          },
        },
      }),
    );

    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    const lines = output.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const jsonOutput = lines.slice(jsonStartIndex).join("\n");
    const parsed = JSON.parse(jsonOutput);

    // Verify nested overrides
    expect(parsed.execution.maxIterations).toBe(15);
    expect(parsed.execution.rectification.enabled).toBe(false);
    expect(parsed.execution.rectification.maxRetries).toBe(5);

    // Verify non-overridden fields are preserved
    expect(parsed.execution.iterationDelayMs).toBeDefined();
    expect(parsed.execution.rectification.fullSuiteTimeoutSeconds).toBeDefined();
  });

  test("handles project config with schema version mismatch", async () => {
    // Create project config with future schema version
    const naxDir = join(tempDir, "nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(
      join(naxDir, "config.json"),
      JSON.stringify({
        version: 999, // Future version
        execution: {
          maxIterations: 25,
        },
      }),
    );

    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    // Should either succeed with warning or fail gracefully
    if (exitCode !== 0) {
      expect(stderr.toLowerCase()).toMatch(/error|invalid|version/);
    } else {
      // If it succeeds, verify output is valid
      const lines = output.split("\n");
      const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
      expect(jsonStartIndex).toBeGreaterThan(0);
      const jsonOutput = lines.slice(jsonStartIndex).join("\n");
      expect(() => JSON.parse(jsonOutput)).not.toThrow();
    }
  });
});
