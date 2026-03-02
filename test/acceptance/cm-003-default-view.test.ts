/**
 * Acceptance Tests for CM-003: nax config (default view)
 *
 * Tests the acceptance criteria for running `nax config` without flags.
 *
 * ACCEPTANCE CRITERIA:
 * 1. Running `nax config` prints the effective merged config as formatted JSON
 * 2. Header shows paths of config files found (global, project)
 * 3. Missing config files noted in header
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("CM-003: nax config (default view)", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cm-003-test-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  // AC1: Running `nax config` prints the effective merged config as formatted JSON
  test("AC1: prints effective merged config as formatted JSON", async () => {
    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should output valid JSON
    const lines = output.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    expect(jsonStartIndex).toBeGreaterThanOrEqual(0);

    const jsonOutput = lines.slice(jsonStartIndex).join("\n");
    expect(() => JSON.parse(jsonOutput)).not.toThrow();

    // Verify it's the merged config (contains version, models, etc.)
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.version).toBe(1);
    expect(parsed.models).toBeDefined();
    expect(parsed.autoMode).toBeDefined();
    expect(parsed.execution).toBeDefined();

    // Verify it's formatted (pretty-printed with indentation)
    expect(jsonOutput).toContain("  "); // Should have 2-space indentation
  });

  // AC2: Header shows paths of config files found (global, project)
  test("AC2: header shows global config path", async () => {
    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should show global config line
    expect(output).toContain("// Global config:");
  });

  test("AC2: header shows project config path when present", async () => {
    // Create project config
    const naxDir = join(tempDir, "nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(
      join(naxDir, "config.json"),
      JSON.stringify({
        execution: {
          maxIterations: 42,
        },
      }),
    );

    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../bin/nax.ts"), "config"], {
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

    // Verify the merged config reflects project override
    const lines = output.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const jsonOutput = lines.slice(jsonStartIndex).join("\n");
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.execution.maxIterations).toBe(42);
  });

  // AC3: Missing config files noted in header
  test("AC3: notes missing project config in header", async () => {
    // Use a directory without nax/config.json
    const isolatedDir = join(tempDir, "isolated");
    mkdirSync(isolatedDir, { recursive: true });
    process.chdir(isolatedDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../bin/nax.ts"), "config"], {
      cwd: isolatedDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should indicate project config is not found
    expect(output).toContain("// Project config:");
    expect(output).toContain("(not found)");
  });

  // Additional verification: header includes resolution order info
  test("header includes resolution order information", async () => {
    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    // Should show resolution order
    expect(output).toContain("// Resolution order:");
    expect(output).toContain("defaults");
    expect(output).toContain("global");
    expect(output).toContain("project");
  });

  // Additional verification: header precedes JSON
  test("header appears before JSON output with blank line separator", async () => {
    process.chdir(tempDir);

    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../bin/nax.ts"), "config"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    const lines = output.split("\n");

    // Header should come before JSON
    const headerIndex = lines.findIndex((line) => line.includes("// nax Configuration"));
    const jsonIndex = lines.findIndex((line) => line.startsWith("{"));

    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(jsonIndex).toBeGreaterThan(headerIndex);

    // Should have blank line between header and JSON
    expect(lines[jsonIndex - 1]).toBe("");
  });
});
