/**
 * Unit tests for checks-warnings.ts — the non-blocking warning checks.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, type DeepPartial, makeNaxConfig, makeTempDir, withTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config/types";
import {
  _checkDiskSpaceDeps,
  checkBuildCommandInReviewChecks,
  checkDiskSpace,
  checkGitignoreCoversNax,
  parseDiskSpaceOutput,
} from "@/precheck";
import { _ignoredNaxPathsDeps } from "@/utils/ignored-nax-paths";

const tempDirs: string[] = [];

function makeTestDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

function _makeTmpDir(): string {
  return makeTestDir("nax-test-");
}

// checkGitignoreCoversNax — status.json removed from required patterns
// ---------------------------------------------------------------------------

describe("checkGitignoreCoversNax", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = makeTestDir("nax-gitignore-test-");
  });

  test("passes when .gitignore has all required patterns but omits .nax/features/*/status.json", async () => {
    const gitignoreContent = [
      "nax.lock",
      ".nax/**/runs/",
      ".nax/metrics.json",
      ".nax-pids",
      ".nax-wt/",
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
      "**/_nax_suggested_test.py",
      "**/.nax/features/*/fragments/",
    ].join("\n");
    writeFileSync(join(workdir, ".gitignore"), gitignoreContent);

    const result = await checkGitignoreCoversNax(workdir);
    expect(result.message).not.toContain("status.json");
  });
});

describe("checkGitignoreCoversNax — retired acceptance-test patterns", () => {
  const COVERING = [
    "nax.lock",
    ".nax/**/runs/",
    ".nax/metrics.json",
    ".nax-pids",
    ".nax-wt/",
    "**/_nax_suggested_test.py",
    "**/.nax/features/*/fragments/",
  ];

  test("no longer requires the acceptance-test patterns", async () => {
    const workdir = makeTestDir("nax-gitignore-test-");
    writeFileSync(join(workdir, ".gitignore"), COVERING.join("\n"));

    const result = await checkGitignoreCoversNax(workdir);
    expect(result.passed).toBe(true);
  });

  test("warns and names a retired pattern still present, since it hides the committed acceptance tests", async () => {
    const workdir = makeTestDir("nax-gitignore-test-");
    writeFileSync(join(workdir, ".gitignore"), [...COVERING, "**/.nax-acceptance*"].join("\n"));

    const result = await checkGitignoreCoversNax(workdir);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("**/.nax-acceptance*");
    expect(result.message).not.toContain("_nax_acceptance_test.py");
  });

  test("a commented-out retired pattern is not active and does not warn", async () => {
    const workdir = makeTestDir("nax-gitignore-test-");
    writeFileSync(join(workdir, ".gitignore"), [...COVERING, "# **/.nax-acceptance*"].join("\n"));

    const result = await checkGitignoreCoversNax(workdir);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// US-007 (#2534): a broad .gitignore rule hiding nax-tracked files
// ---------------------------------------------------------------------------

describe("checkGitignoreCoversNax — hidden nax-tracked files (US-007)", () => {
  const COVERING = [
    "nax.lock",
    ".nax/**/runs/",
    ".nax/metrics.json",
    ".nax-pids",
    ".nax-wt/",
    "**/_nax_suggested_test.py",
    "**/.nax/features/*/fragments/",
  ];
  /** The rule git reports for a wholesale feature-directory `.gitignore` entry. */
  const LEDGER_RULE = ".gitignore:1:**/.nax/features/*/";
  const LEDGER_LINE = `${LEDGER_RULE}\t.nax/features/_probe/decisions.jsonl\n`;
  const originalDeps = { ..._ignoredNaxPathsDeps };
  afterEach(() => Object.assign(_ignoredNaxPathsDeps, originalDeps));

  /** A project whose .gitignore holds every required pattern, with `check-ignore` stubbed. */
  async function check(stdout: string, exitCode = 0) {
    _ignoredNaxPathsDeps.git = async () => ({ stdout, exitCode });
    return withTempDir(async (workdir) => {
      writeFileSync(join(workdir, ".gitignore"), COVERING.join("\n"));
      return checkGitignoreCoversNax(workdir);
    });
  }

  test("AC-10: a hidden ledger fails the check and names the rule that hides it", async () => {
    const result = await check(LEDGER_LINE);

    expect(result.passed).toBe(false);
    expect(result.message).toContain(LEDGER_RULE);
  });

  test("AC-11: the same failure names the .gitignore line that re-includes the ledger", async () => {
    const result = await check(LEDGER_LINE);

    expect(result.message).toContain("!.nax/features/*/decisions.jsonl");
  });

  test("a rule hiding none of the nax-tracked paths keeps the check passing", async () => {
    const result = await check("", 1);

    expect(result.passed).toBe(true);
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

  test("adversarial fix: a malformed available-space token with a trailing non-digit (e.g. '250000x') is treated as a parse failure, not accepted as 250000", () => {
    const output = [
      "Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted",
      "/dev/disk1s1 1000000000 500000000 250000x 50% 1234 5678 10% /",
    ].join("\n");

    const result = parseDiskSpaceOutput(output);

    expect(result.passed).toBe(false);
    expect(result.message).not.toContain("NaN");
    expect(result.message.toLowerCase()).toMatch(/parse|unable|could not/);
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
