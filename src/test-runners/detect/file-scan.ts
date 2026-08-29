/**
 * Tier 3 — File System Scan
 *
 * Walks `git ls-files` output, buckets files by common test-file suffix,
 * and emits globs for suffixes meeting a count threshold.
 *
 * Threshold: ≥5 files with the suffix OR ≥10% of total files.
 * Excluded: node_modules/, dist/, build/, .nax/, coverage/, .git/
 */

import { killProcessGroup } from "@/utils/process-kill";
import type { DetectionSource } from "./types";

/** Directories excluded from file scan */
const EXCLUDED_DIR_PREFIXES = ["node_modules/", "dist/", "build/", ".nax/", "coverage/", ".git/"];

/** Min file count to consider a suffix as a test-file indicator */
const MIN_COUNT_THRESHOLD = 5;
/** Min fraction of all files to consider a suffix as a test-file indicator */
const MIN_FRACTION_THRESHOLD = 0.1;

/**
 * Hard deadline on `git ls-files` so a wedged git (NFS / lock contention) does
 * not stall Tier 3 detection indefinitely. Mirrors `gitWithTimeout` in
 * `src/utils/git.ts` and `_isolationDeps.timeoutMs` in `src/tdd/isolation.ts`:
 * SIGKILL the process group on expiry, degrade to the existing empty-result
 * contract. Tests inject a short value via `_fileScanDeps.timeoutMs`.
 */
const FILE_SCAN_GIT_TIMEOUT_MS = 10_000;

/** Common test-file suffix patterns to look for */
const CANDIDATE_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.jsx",
  ".spec.ts",
  ".spec.tsx",
  ".spec.js",
  ".spec.jsx",
  ".e2e-spec.ts",
  ".e2e-spec.js",
  "_test.go",
  "_test.py",
  "test_.py",
] as const;

/** Map from suffix to glob pattern */
const SUFFIX_TO_GLOB: Record<string, string> = {
  ".test.ts": "**/*.test.ts",
  ".test.tsx": "**/*.test.tsx",
  ".test.js": "**/*.test.js",
  ".test.jsx": "**/*.test.jsx",
  ".spec.ts": "**/*.spec.ts",
  ".spec.tsx": "**/*.spec.tsx",
  ".spec.js": "**/*.spec.js",
  ".spec.jsx": "**/*.spec.jsx",
  ".e2e-spec.ts": "**/*.e2e-spec.ts",
  ".e2e-spec.js": "**/*.e2e-spec.js",
  "_test.go": "**/*_test.go",
  "_test.py": "**/*_test.py",
  "test_.py": "**/test_*.py",
};

/** Injectable deps for testability */
export const _fileScanDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
  killProcessGroup,
  timeoutMs: FILE_SCAN_GIT_TIMEOUT_MS,
};

/**
 * Run `git ls-files` and return the output lines.
 * Returns empty array when git is unavailable, workdir is not a repo, or
 * `git ls-files` exceeds its hard deadline (the SIGKILL-on-expiry contract
 * degrades to the same empty result a non-zero exit produces).
 */
async function gitLsFiles(workdir: string): Promise<string[]> {
  try {
    const proc = _fileScanDeps.spawn(["git", "ls-files"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      _fileScanDeps.killProcessGroup(proc.pid, "SIGKILL");
    }, _fileScanDeps.timeoutMs);

    // Drain concurrently with the exit wait — a child that fills its pipe's OS
    // buffer before being read would otherwise block on the write and never
    // reach `exited`, defeating the SIGKILL the timeout relies on.
    const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
    const stderrPromise = new Response(proc.stderr).text().catch(() => "");

    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (timedOut) return [];
    if (exitCode !== 0) return [];

    const stdout = await stdoutPromise;
    void (await stderrPromise);
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Returns true when the path should be excluded */
function isExcluded(path: string): boolean {
  return EXCLUDED_DIR_PREFIXES.some((prefix) => path.startsWith(prefix) || path.includes(`/${prefix}`));
}

/**
 * Scan git-tracked files and detect test-file patterns by suffix frequency.
 * Returns null when no patterns meet the threshold.
 */
export async function detectFromFileScan(workdir: string): Promise<DetectionSource | null> {
  const files = await gitLsFiles(workdir);
  const filtered = files.filter((f) => !isExcluded(f));

  if (filtered.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const suffix of CANDIDATE_SUFFIXES) {
    counts[suffix] = 0;
  }

  for (const file of filtered) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      if (file.endsWith(suffix)) {
        counts[suffix] = (counts[suffix] ?? 0) + 1;
      }
    }
  }

  const totalFiles = filtered.length;
  const patterns: string[] = [];

  for (const suffix of CANDIDATE_SUFFIXES) {
    const count = counts[suffix] ?? 0;
    if (count === 0) continue;
    if (count >= MIN_COUNT_THRESHOLD || count / totalFiles >= MIN_FRACTION_THRESHOLD) {
      const glob = SUFFIX_TO_GLOB[suffix];
      if (glob) patterns.push(glob);
    }
  }

  if (patterns.length === 0) return null;

  return {
    type: "file-scan",
    path: workdir,
    patterns,
  };
}
