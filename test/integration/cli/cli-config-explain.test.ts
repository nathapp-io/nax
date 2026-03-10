/**
 * Integration tests for `nax config --explain` prompts section (PB-005)
 *
 * Verifies that the prompts.overrides config block is documented in the
 * --explain output with example paths.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      output.includes("test-writer") || output.includes("implementer") || output.includes("verifier");
    expect(mentionsRole).toBe(true);
  });
});

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
    const mentionsLegacy = output.includes("git-grep") || output.includes("legacy") || output.includes("non-MCP");
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
      output.includes("rate-limited") || output.includes("fallback") || output.includes("retry");
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
    const hasAutoModeSection = output.includes("autoMode") && output.includes("configuration");
    expect(hasAutoModeSection).toBe(true);
  });
});
