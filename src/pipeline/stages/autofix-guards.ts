/**
 * Safety guards for the autofix test-writer op in mock-restructure mode.
 *
 * Guard A (assertionSiteDiffCheck): detects if the test-writer weakened assertions.
 * Guard B (runIsolationGuard): verifies test-writer only edited test files.
 * revertDiff: undoes committed changes via `git checkout HEAD -- <files>`.
 */

import type { NaxConfig } from "@/config/runtime-types";
import { NaxError } from "@/errors";
import { verifyTestWriterIsolation } from "@/tdd";
import { resolveTestFilePatterns } from "@/test-runners";
import { spawn } from "@/utils/bun-deps";

/** Injectable deps for testability. */
export const _guardDeps = {
  spawn,
  verifyTestWriterIsolation,
};

const ASSERTION_PATTERN = /expect\(|\.toBe\(|\.toEqual\(|\.toThrow\(|\bnot\.|\.toMatch\(|\bassert\./;

export type AssertionCheckResult =
  | { violated: true; file: string; line: number; content: string }
  | { violated: false };

/**
 * Diffs each file against beforeRef using `git diff --unified=0`.
 * Returns violated with file/line/content on the first added line matching assertion patterns.
 */
export async function assertionSiteDiffCheck(
  workdir: string,
  beforeRef: string,
  files: string[],
): Promise<AssertionCheckResult> {
  if (files.length === 0) return { violated: false };

  for (const file of files) {
    const proc = _guardDeps.spawn(["git", "diff", "--unified=0", beforeRef, "--", file], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, diffOutput] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) continue;

    const lines = diffOutput.split("\n");
    let lineNumber = 0;

    for (const rawLine of lines) {
      // Track line numbers from hunk headers: @@ -a,b +c,d @@
      const hunkMatch = rawLine.match(/^@@[^+]*\+(\d+)/);
      if (hunkMatch) {
        lineNumber = Number.parseInt(hunkMatch[1], 10) - 1;
        continue;
      }

      if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
        lineNumber++;
        const content = rawLine.slice(1);
        if (ASSERTION_PATTERN.test(content)) {
          return { violated: true, file, line: lineNumber, content };
        }
      } else if (rawLine.startsWith(" ")) {
        lineNumber++;
      }
    }
  }

  return { violated: false };
}

export type IsolationGuardResult = { violated: true; files: string[] } | { violated: false; skipped?: true };

/**
 * Runs verifyTestWriterIsolation unless enforceTestWriterIsolation is false.
 * Returns violated with the list of offending files, or skipped when disabled.
 *
 * `mode` mirrors the test-writer prompt contract: `"lite"` lets stub-sized src/
 * writes ride as soft violations to match the three-session-tdd-lite prompt;
 * `"strict"` (default) is the three-session-tdd contract.
 */
export async function runIsolationGuard(
  workdir: string,
  beforeRef: string,
  config: NaxConfig,
  packageDir?: string,
  mode: "strict" | "lite" = "strict",
): Promise<IsolationGuardResult> {
  if (config.quality.autofix?.enforceTestWriterIsolation === false) {
    return { violated: false, skipped: true };
  }

  const resolved = await resolveTestFilePatterns(config, workdir, packageDir);
  const result = await _guardDeps.verifyTestWriterIsolation(
    workdir,
    beforeRef,
    config.tdd?.testWriterAllowedPaths,
    resolved.globs,
    mode,
  );

  if (!result.passed) {
    return { violated: true, files: result.violations ?? [] };
  }

  return { violated: false };
}

/**
 * Reverts committed changes by running `git checkout HEAD -- <files>`.
 */
export async function revertDiff(workdir: string, files: string[]): Promise<void> {
  if (files.length === 0) return;

  const proc = _guardDeps.spawn(["git", "checkout", "HEAD", "--", ...files], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new NaxError(`[autofix-guards] git checkout HEAD failed with exit code ${exitCode}`, "GIT_CHECKOUT_FAILED", {
      stage: "autofix-guards",
      workdir,
      files,
      exitCode,
    });
  }
}
