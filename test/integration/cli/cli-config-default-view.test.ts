// RE-ARCH: keep
/**
 * CLI Integration Tests for `nax config` Default View
 *
 * Tests the full end-to-end flow of running `nax config` without flags
 * via the CLI entry point (bin/nax.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("nax config (default view) - CLI integration", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Create temp directory
    tempDir = mkdtempSync(join(tmpdir(), "nax-config-cli-test-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    // Cleanup
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("prints effective merged config as JSON with header", async () => {
    process.chdir(tempDir);

    // Run `nax config` command
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should have header
    expect(output).toContain("// nax Configuration");
    expect(output).toContain("// Resolution order: defaults → global → project → CLI overrides");
    expect(output).toContain("// Global config:");
    expect(output).toContain("// Project config:");

    // Should have valid JSON after header
    const lines = output.split("\n");
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

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should show global config path (may be "not found" or actual path)
    expect(output).toContain("// Global config:");
  });

  test("shows (not found) for missing project config", async () => {
    // Use a directory without nax/config.json
    const isolatedDir = join(tempDir, "isolated");
    mkdirSync(isolatedDir, { recursive: true });
    process.chdir(isolatedDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: isolatedDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should show project config as not found
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

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should show project config path
    expect(output).toContain("// Project config:");
    expect(output).toContain("config.json");

    // Should reflect merged config
    const lines = output.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const jsonOutput = lines.slice(jsonStartIndex).join("\n");
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.execution.maxIterations).toBe(20);
  });

  test("header precedes JSON output with blank line", async () => {
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

    // Find header and JSON start
    const headerLineIndex = lines.findIndex((line) => line.includes("// nax Configuration"));
    const jsonLineIndex = lines.findIndex((line) => line.startsWith("{"));

    expect(headerLineIndex).toBeGreaterThanOrEqual(0);
    expect(jsonLineIndex).toBeGreaterThan(headerLineIndex);

    // Should have blank line between header and JSON
    expect(lines[jsonLineIndex - 1]).toBe("");
  });

  test("JSON output is pretty-printed (indented)", async () => {
    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // JSON should be pretty-printed with 2-space indentation
    expect(output).toMatch(/"version": 1/);
    expect(output).toMatch(/"models": \{/);
    expect(output).toContain("  "); // Should have indentation
  });

  test("works when run from project subdirectory", async () => {
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

    // Create subdirectory and run from there
    const subdir = join(tempDir, "src", "components");
    mkdirSync(subdir, { recursive: true });
    process.chdir(subdir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/nax.ts"), "config"], {
      cwd: subdir,
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
    expect(parsed.execution.maxIterations).toBe(30);
  });
});
