/**
 * Unit tests for checks-warnings.ts — prompt override file checks (PB-005)
 *
 * Tests the new checkPromptOverrideFiles check which warns when a configured
 * override file path does not exist. Non-blocking: run continues regardless.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DeepPartial, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config/types";
import {
  _checkDiskSpaceDeps,
  checkBuildCommandInReviewChecks,
  checkDiskSpace,
  checkGitignoreCoversNax,
  checkPromptOverrideFiles,
  parseDiskSpaceOutput,
} from "@/precheck";

function makeTmpDir(): string {
  return makeTempDir("nax-test-");
}

function makeMinimalConfig(overrides?: Record<string, string>): NaxConfig {
  return makeNaxConfig({
    prompts: overrides ? { overrides } : undefined,
  });
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
      implementer: ".nax/prompts/implementer.md",
    });
    const checks = await checkPromptOverrideFiles(config, workdir);

    expect(checks[0].message).toContain(workdir);
  });

  test("emits one warning per missing role", async () => {
    const config = makeMinimalConfig({
      "test-writer": ".nax/prompts/test-writer.md",
      implementer: ".nax/prompts/implementer.md",
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
      implementer: ".nax/prompts/implementer.md", // does not exist
    });
    const checks = await checkPromptOverrideFiles(config, workdir);

    expect(checks).toHaveLength(1);
    expect(checks[0].message).toContain("implementer");
  });

  test("warning check name identifies the role", async () => {
    const config = makeMinimalConfig({
      verifier: ".nax/prompts/verifier.md",
    });
    const checks = await checkPromptOverrideFiles(config, workdir);

    expect(checks[0].name).toContain("prompt-override");
    expect(checks[0].name).toContain("verifier");
  });
});

// checkGitignoreCoversNax — status.json removed from required patterns
// ---------------------------------------------------------------------------

describe("checkGitignoreCoversNax", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-gitignore-test-");
  });

  test("passes when .gitignore has all required patterns but omits .nax/features/*/status.json", async () => {
    const gitignoreContent = [
      "nax.lock",
      ".nax/**/runs/",
      ".nax/metrics.json",
      ".nax-pids",
      ".nax-wt/",
      "**/.nax-acceptance*",
      "**/_nax_acceptance_test.py",
      "**/_nax_suggested_test.py",
      "**/.nax/features/*/fragments/",
    ].join("\n");
    writeFileSync(join(workdir, ".gitignore"), gitignoreContent);

    const result = await checkGitignoreCoversNax(workdir);
    expect(result.passed).toBe(true);
  });

  test("patterns array does not include .nax/features/*/status.json", async () => {
    // A gitignore that has all current required patterns but NOT status.json should pass
    const gitignoreContent = [
      "nax.lock",
      ".nax/**/runs/",
      ".nax/metrics.json",
      ".nax-pids",
      ".nax-wt/",
      "**/.nax-acceptance*",
      "**/_nax_acceptance_test.py",
      "**/_nax_suggested_test.py",
      "**/.nax/features/*/fragments/",
    ].join("\n");
    writeFileSync(join(workdir, ".gitignore"), gitignoreContent);

    const result = await checkGitignoreCoversNax(workdir);
    expect(result.message).not.toContain("status.json");
  });
});

// BUG-092: build command configured but not in review.checks
// ---------------------------------------------------------------------------

function makeBugConfig(overrides: DeepPartial<NaxConfig> = {}): NaxConfig {
  return makeNaxConfig({
    review: {
      checks: ["typecheck", "lint"],
      commands: {},
    },
    quality: { commands: {} },
    ...overrides,
  });
}

describe("checkBuildCommandInReviewChecks (BUG-092)", () => {
  test("passes when no build command configured", () => {
    const result = checkBuildCommandInReviewChecks(makeBugConfig());
    expect(result.passed).toBe(true);
  });

  test("warns when quality.commands.build set but build not in review.checks", () => {
    const result = checkBuildCommandInReviewChecks(
      makeBugConfig({ quality: { commands: { build: "bun run build" } } }),
    );
    expect(result.passed).toBe(false);
    expect(result.tier).toBe("warning");
    expect(result.message).toContain("build");
    expect(result.message).toContain("review.checks");
  });

  test("warns when review.commands.build set but build not in review.checks", () => {
    const result = checkBuildCommandInReviewChecks(
      makeBugConfig({
        review: {
          checks: ["typecheck", "lint"],
          commands: { build: "bun run build" },
          semantic: { rules: [], timeoutMs: 600000, excludePatterns: [] },
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain("review.checks");
  });

  test("passes when build command set AND build is in review.checks", () => {
    const result = checkBuildCommandInReviewChecks(
      makeBugConfig({
        quality: { commands: { build: "bun run build" } },
        review: {
          checks: ["typecheck", "lint", "build"],
          commands: {},
          semantic: { rules: [], timeoutMs: 600000, excludePatterns: [] },
        },
      }),
    );
    expect(result.passed).toBe(true);
  });
});

// US-005 AC6: disk-space warning check must surface a parse failure (no NaN)
// when the df output's data line has fewer columns than the available-space column.
// ---------------------------------------------------------------------------

describe("parseDiskSpaceOutput (US-005 AC6)", () => {
  test("returns passed:false with a parse-failure message and no NaN text when the data line has fewer columns than the available-space column", () => {
    // Real `df -k .` output: header + one data line with 6 columns
    //   Filesystem 1024-blocks Used Available Capacity iused ifree %iused  Mounted
    // The available-space column is at index 3; this data line only has 3 columns,
    // so the parse must fail cleanly rather than rendering "NaN" in the message.
    const output = [
      "Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted",
      "/dev/disk1s1 short",
    ].join("\n");

    const result = parseDiskSpaceOutput(output);

    expect(result.passed).toBe(false);
    expect(result.message).not.toContain("NaN");
    // The message must state that the output could not be parsed.
    expect(result.message.toLowerCase()).toMatch(/parse|unable|could not/);
  });

  test("returns passed:true with an available-space message when the data line has all six columns and plenty of available KB", () => {
    const output = [
      "Filesystem 1024-blocks Used Available Capacity iused iffree %iused Mounted",
      "/dev/disk1s1 1000000000 500000000 500000000 50% 1234 5678 10% /",
    ].join("\n");

    const result = parseDiskSpaceOutput(output);

    expect(result.passed).toBe(true);
    expect(result.message).toContain("Disk space");
    expect(result.message).not.toContain("NaN");
  });

  test("returns passed:false with a parse-failure message when the output has no data line", () => {
    const result = parseDiskSpaceOutput("Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted");
    expect(result.passed).toBe(false);
    expect(result.message).not.toContain("NaN");
  });
});

describe("checkDiskSpace (US-005 AC6 — spawn seam)", () => {
  test("delegates parsing of the spawned df output to parseDiskSpaceOutput", async () => {
    const origSpawn = _checkDiskSpaceDeps.spawn;
    const origGetStdout = _checkDiskSpaceDeps.getStdout;
    const origGetExitCode = _checkDiskSpaceDeps.getExitCode;

    _checkDiskSpaceDeps.spawn = mock(() => ({
      stdout: new ReadableStream<Uint8Array>(),
      exited: Promise.resolve(0),
    })) as typeof _checkDiskSpaceDeps.spawn;
    _checkDiskSpaceDeps.getExitCode = mock(async () => 0) as typeof _checkDiskSpaceDeps.getExitCode;
    _checkDiskSpaceDeps.getStdout = mock(async () =>
      ["Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted", "/dev/disk1s1 short"].join("\n"),
    ) as typeof _checkDiskSpaceDeps.getStdout;

    try {
      const result = await checkDiskSpace();
      expect(result.passed).toBe(false);
      expect(result.message).not.toContain("NaN");
      expect(result.message.toLowerCase()).toMatch(/parse|unable|could not/);
    } finally {
      _checkDiskSpaceDeps.spawn = origSpawn;
      _checkDiskSpaceDeps.getStdout = origGetStdout;
      _checkDiskSpaceDeps.getExitCode = origGetExitCode;
    }
  });
});
