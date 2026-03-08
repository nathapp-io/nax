/**
 * Integration tests for `nax config --explain` prompts section (PB-005)
 *
 * Verifies that the prompts.overrides config block is documented in the
 * --explain output with example paths.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configCommand } from "../../../src/cli/config";
import { loadConfig } from "../../../src/config/loader";

describe("config --explain: prompts section", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-config-prompts-test-"));
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

  test("explain output includes a prompts section", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    expect(output).toContain("prompts");
  });

  test("explain output documents prompts.overrides", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    expect(output).toContain("prompts.overrides");
  });

  test("explain output includes example path .nax/prompts/test-writer.md", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    expect(output).toContain(".nax/prompts/test-writer.md");
  });

  test("explain output mentions override roles (test-writer, implementer, verifier)", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // At least one of the roles should appear in the prompts documentation
    const mentionsRole =
      output.includes("test-writer") ||
      output.includes("implementer") ||
      output.includes("verifier");
    expect(mentionsRole).toBe(true);
  });
});
