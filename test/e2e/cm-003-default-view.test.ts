// RE-ARCH: keep
/**
 * Acceptance Tests for CM-003: nax config (default view)
 *
 * Tests the acceptance criteria for running `nax config` without flags.
 * Uses direct configCommand() calls (no subprocess) to avoid cold-start
 * timeouts on GitHub Actions shared runners.
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
import { configCommand } from "../../src/cli/config";
import { loadConfig } from "../../src/config/loader";

/** Capture console.log while running configCommand directly. Caller must chdir first. */
async function runConfigCommand(): Promise<{ stdout: string; stderr: string; error?: Error }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => outLines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errLines.push(args.map(String).join(" "));
  try {
    const config = await loadConfig(); // uses process.cwd() via findProjectDir()
    await configCommand(config);
    return { stdout: outLines.join("\n"), stderr: errLines.join("\n") };
  } catch (err) {
    return { stdout: outLines.join("\n"), stderr: errLines.join("\n"), error: err as Error };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

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
    const { stdout, error } = await runConfigCommand();
    expect(error).toBeUndefined();

    const lines = stdout.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    expect(jsonStartIndex).toBeGreaterThanOrEqual(0);

    const jsonOutput = lines.slice(jsonStartIndex).join("\n");
    expect(() => JSON.parse(jsonOutput)).not.toThrow();

    const parsed = JSON.parse(jsonOutput);
    expect(parsed.version).toBe(1);
    expect(parsed.models).toBeDefined();
    expect(parsed.autoMode).toBeDefined();
    expect(parsed.execution).toBeDefined();
    expect(jsonOutput).toContain("  "); // pretty-printed
  });

  // AC2: Header shows paths of config files found (global, project)
  test("AC2: header shows global config path", async () => {
    process.chdir(tempDir);
    const { stdout, error } = await runConfigCommand();
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Global config:");
  });

  test("AC2: header shows project config path when present", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({ execution: { maxIterations: 42 } }));

    process.chdir(tempDir);
    const { stdout, error } = await runConfigCommand();
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Project config:");
    expect(stdout).toContain("config.json");

    const lines = stdout.split("\n");
    const jsonStartIndex = lines.findIndex((line) => line.startsWith("{"));
    const parsed = JSON.parse(lines.slice(jsonStartIndex).join("\n"));
    expect(parsed.execution.maxIterations).toBe(42);
  });

  // AC3: Missing config files noted in header
  test("AC3: notes missing project config in header", async () => {
    const isolatedDir = join(tempDir, "isolated");
    mkdirSync(isolatedDir, { recursive: true });
    process.chdir(isolatedDir);

    const { stdout, error } = await runConfigCommand();
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Project config:");
    expect(stdout).toContain("(not found)");
  });

  test("header includes resolution order information", async () => {
    process.chdir(tempDir);
    const { stdout, error } = await runConfigCommand();
    expect(error).toBeUndefined();
    expect(stdout).toContain("// Resolution order:");
    expect(stdout).toContain("defaults");
    expect(stdout).toContain("global");
    expect(stdout).toContain("project");
  });

  test("header appears before JSON output with blank line separator", async () => {
    process.chdir(tempDir);
    const { stdout, error } = await runConfigCommand();
    expect(error).toBeUndefined();

    const lines = stdout.split("\n");
    const headerIndex = lines.findIndex((line) => line.includes("// nax Configuration"));
    const jsonIndex = lines.findIndex((line) => line.startsWith("{"));

    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(jsonIndex).toBeGreaterThan(headerIndex);
    expect(lines[jsonIndex - 1]).toBe("");
  });
});
