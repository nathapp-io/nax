/**
 * Integration tests for `nax config --explain` autoMode section (MA-011)
 *
 * Verifies that the autoMode multi-agent configuration is documented in the
 * --explain output, including defaultAgent, fallbackOrder, and model mapping rules.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configCommand } from "../../../src/cli/config";
import { loadConfig } from "../../../src/config/loader";

describe("config --explain: autoMode multi-agent section", () => {
  let tempDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-config-agents-test-"));
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

  test("explain output documents defaultAgent configuration", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    expect(output).toContain("autoMode.defaultAgent");
  });

  test("explain output documents fallbackOrder configuration", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    expect(output).toContain("autoMode.fallbackOrder");
  });

  test("explain output includes documentation for fallback logic", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // Should explain what fallback order does and when it's used
    const fallbackSectionStart = output.indexOf("fallbackOrder");
    expect(fallbackSectionStart).toBeGreaterThan(-1);
    // The description should mention rate-limited or retry concepts
    const hasFallbackLogicDoc =
      output.includes("rate-limited") ||
      output.includes("fallback") ||
      output.includes("retry");
    expect(hasFallbackLogicDoc).toBe(true);
  });

  test("explain output documents model mapping rules in complexityRouting", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // Should document complexity tiers and their model mappings
    expect(output).toContain("complexityRouting");
    expect(output).toContain("simple");
    expect(output).toContain("medium");
    expect(output).toContain("complex");
    expect(output).toContain("expert");
  });

  test("explain output documents model tier mapping (models section)", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // Should document the models section which defines the tier mappings
    expect(output).toContain("models.fast");
    expect(output).toContain("models.balanced");
    expect(output).toContain("models.powerful");
  });

  test("explain output includes examples of agent names in defaultAgent", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // The description should include examples like 'claude', 'codex'
    const defaultAgentSection = output.substring(
      output.indexOf("autoMode.defaultAgent"),
      output.indexOf("autoMode.defaultAgent") + 500,
    );
    const hasExamples =
      defaultAgentSection.includes("claude") ||
      defaultAgentSection.includes("codex") ||
      defaultAgentSection.includes("example");
    expect(hasExamples).toBe(true);
  });

  test("explain output explains escalation configuration", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // Should document the escalation settings
    expect(output).toContain("escalation");
    expect(output).toContain("tierOrder");
  });

  test("explain output includes multi-agent orchestration context", async () => {
    const config = await loadConfig(tempDir);
    await configCommand(config, { explain: true });

    const output = consoleOutput.join("\n");
    // Overall context about multi-agent orchestration should be clear
    const hasAutoModeSection =
      output.includes("autoMode") && output.includes("configuration");
    expect(hasAutoModeSection).toBe(true);
  });
});
