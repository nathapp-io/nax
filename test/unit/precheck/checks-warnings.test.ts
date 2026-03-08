/**
 * Unit tests for checks-warnings.ts — prompt override file checks (PB-005)
 *
 * Tests the new checkPromptOverrideFiles check which warns when a configured
 * override file path does not exist. Non-blocking: run continues regardless.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, test } from "bun:test";
import type { NaxConfig } from "../../../src/config/types";
import { checkPromptOverrideFiles } from "../../../src/precheck/checks-warnings";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nax-test-"));
}

function makeMinimalConfig(overrides?: Record<string, string>): NaxConfig {
  return {
    prompts: overrides ? { overrides } : undefined,
  } as unknown as NaxConfig;
}

describe("checkPromptOverrideFiles", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = makeTmpDir();
  });

  test("no warning when config.prompts is absent", async () => {
    const config = makeMinimalConfig(undefined);
    const checks = await checkPromptOverrideFiles(config, workdir);
    expect(checks).toHaveLength(0);
  });

  test("no warning when config.prompts.overrides is empty", async () => {
    const config = makeMinimalConfig({});
    const checks = await checkPromptOverrideFiles(config, workdir);
    expect(checks).toHaveLength(0);
  });

  test("no warning when override file exists", async () => {
    // Create the override file
    const promptsDir = join(workdir, ".nax", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    const filePath = join(promptsDir, "test-writer.md");
    writeFileSync(filePath, "# Test Writer Prompt");

    const config = makeMinimalConfig({
      "test-writer": ".nax/prompts/test-writer.md",
    });
    const checks = await checkPromptOverrideFiles(config, workdir);
    expect(checks).toHaveLength(0);
  });

  test("emits warning when override file is missing", async () => {
    const config = makeMinimalConfig({
      "test-writer": ".nax/prompts/test-writer.md",
    });
    const checks = await checkPromptOverrideFiles(config, workdir);

    expect(checks).toHaveLength(1);
    expect(checks[0].tier).toBe("warning");
    expect(checks[0].passed).toBe(false);
    expect(checks[0].message).toContain("test-writer");
    expect(checks[0].message).toContain("test-writer.md");
  });

  test("warning message contains resolved absolute path", async () => {
    const config = makeMinimalConfig({
      "implementer": ".nax/prompts/implementer.md",
    });
    const checks = await checkPromptOverrideFiles(config, workdir);

    expect(checks[0].message).toContain(workdir);
  });

  test("emits one warning per missing role", async () => {
    const config = makeMinimalConfig({
      "test-writer": ".nax/prompts/test-writer.md",
      "implementer": ".nax/prompts/implementer.md",
    });
    const checks = await checkPromptOverrideFiles(config, workdir);

    expect(checks).toHaveLength(2);
  });

  test("only warns for missing files, not existing ones", async () => {
    const promptsDir = join(workdir, ".nax", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(promptsDir, "test-writer.md"), "# exists");

    const config = makeMinimalConfig({
      "test-writer": ".nax/prompts/test-writer.md",
      "implementer": ".nax/prompts/implementer.md", // does not exist
    });
    const checks = await checkPromptOverrideFiles(config, workdir);

    expect(checks).toHaveLength(1);
    expect(checks[0].message).toContain("implementer");
  });

  test("warning check name identifies the role", async () => {
    const config = makeMinimalConfig({
      "verifier": ".nax/prompts/verifier.md",
    });
    const checks = await checkPromptOverrideFiles(config, workdir);

    expect(checks[0].name).toContain("prompt-override");
    expect(checks[0].name).toContain("verifier");
  });
});
