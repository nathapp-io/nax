/**
 * Integration tests for `nax config --explain` context.fileInjection section (CTX-002)
 *
 * Verifies that the context.fileInjection config option is documented in the
 * --explain output, including the 'keyword' and 'disabled' modes and their rationale.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configCommand } from "../../../src/cli/config";
import { loadConfig } from "../../../src/config/loader";

describe("config --explain: context.fileInjection section", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-config-ctx-explain-test-"));
    originalCwd = process.cwd();

    consoleOutput = [];
    originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("explain output contains 'fileInjection'", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    expect(output).toContain("fileInjection");
  });

  test("explain output documents 'keyword' as a valid fileInjection mode", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // 'keyword' must appear in the context section description, not just routing
    const contextSectionIndex = output.indexOf("# Context injection");
    expect(contextSectionIndex).toBeGreaterThan(-1);
    const contextSection = output.slice(contextSectionIndex);
    expect(contextSection).toContain("keyword");
  });

  test("explain output documents 'disabled' as the default fileInjection mode", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // 'disabled' must appear in the context section (as documented default), not just as a raw value
    const contextSectionIndex = output.indexOf("# Context injection");
    expect(contextSectionIndex).toBeGreaterThan(-1);
    const contextSection = output.slice(contextSectionIndex);
    // The description comment (# ...) for fileInjection should mention 'disabled'
    const fileInjectionDescIndex = contextSection.indexOf("fileInjection");
    expect(fileInjectionDescIndex).toBeGreaterThan(-1);
    const afterFileInjection = contextSection.slice(0, fileInjectionDescIndex);
    // There should be a comment before fileInjection key that mentions 'disabled'
    expect(afterFileInjection).toContain("disabled");
  });

  test("explain output documents MCP-aware agents rationale for 'disabled' default", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // The description should explain why 'disabled' is the default
    expect(output).toContain("MCP");
  });

  test("explain output documents legacy git-grep injection rationale for 'keyword'", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // The description should explain that 'keyword' preserves legacy git-grep injection
    const mentionsLegacy =
      output.includes("git-grep") ||
      output.includes("legacy") ||
      output.includes("non-MCP");
    expect(mentionsLegacy).toBe(true);
  });

  test("explain output shows example context.fileInjection usage", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // Should include an example showing the 'keyword' value
    expect(output).toContain("context.fileInjection");
  });
});
