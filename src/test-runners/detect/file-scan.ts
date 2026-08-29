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

/**
 * Sentinel returned by {@link raceWithDeadline} when the deadline wins. Mirrors
 * the DRAIN_TIMEOUT symbol in `src/verification/executor.ts` — duplicated here
 * because routing the import through `@/verification`'s barrel would create a
 * runtime cycle (`verification/flake-baseline-diff.ts` already pulls from
 * `test-runners`, closing the loop on detect/). Local copy keeps the cycle
 * ratchet at its baseline.
 */
const DRAIN_TIMEOUT = Symbol("drain-timeout");

/**
 * Race `p` against a `deadlineMs` setTimeout. The timer resolves directly with
 * DRAIN_TIMEOUT — we do NOT rely on `p` settling itself. Mirrors the helper
 * in `src/verification/executor.ts`. Local copy for the same cycle-ratchet
 * reason as DRAIN_TIMEOUT above.
 */
function raceWithDeadline<T>(p: Promise<T>, deadlineMs: number): Promise<T | typeof DRAIN_TIMEOUT> {
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
  const timeoutP = new Promise<typeof DRAIN_TIMEOUT>((r) => {
    timer.id = setTimeout(() => r(DRAIN_TIMEOUT), deadlineMs);
  });
  return Promise.race([p, timeoutP]).finally(() => {
    if (timer.id !== undefined) clearTimeout(timer.id);
  });
}

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
const FILE_SCAN_GIT_TIMEOUT_MS = 4_000;

/**
 * Cap on the stdout/stderr drain after proc.exited resolves. proc.exited only
 * signals the direct child exiting — a grandchild that inherited the pipe
 * write-end keeps the streams open indefinitely. Without a deadline, the
 * drain itself becomes the new stall point. Mirrors the drainTimeoutMs in
 * verification/executor.ts (BUG-2). Tests inject a short value via
 * `_fileScanDeps.drainTimeoutMs`.
 */
const FILE_SCAN_DRAIN_TIMEOUT_MS = 2_000;

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
  drainTimeoutMs: FILE_SCAN_DRAIN_TIMEOUT_MS,
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
      // Bun.spawn does not setpgid children into their own group by default, so
      // killProcessGroup(-pid) on timeout would hit ESRCH and fall back to
      // killing only the direct child (leaking any grandchildren — git's own
      // subprocesses, an NFS-handle helper, etc.). `detached` makes this
      // process a session/group leader via setsid(), so its own PID IS the
      // real pgid. Matches the established pattern in verification/executor.ts
      // and worktree/dependencies.ts.
      detached: true,
    });

    // Race `proc.exited` against a hard deadline so a wedged child cannot stall
    // the caller indefinitely. The timer resolves the race directly on expiry
    // — we do NOT rely on SIGKILL causing `proc.exited` to settle, because
    // that side-effect is an implementation detail of the child and not part
    // of the contract this helper guarantees. Mirrors the defensive
    // `awaitProcExit` shape from `src/execution/pid-registry.ts`.
    const exitCode: number = await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      };
      const timer = setTimeout(() => {
        try {
          _fileScanDeps.killProcessGroup(proc.pid, "SIGKILL");
        } catch {
          // Process may have already exited; the deadline below still wins.
        }
        finish(-1);
      }, _fileScanDeps.timeoutMs);
      proc.exited.then(finish, () => finish(-1));
    });

    // Drain concurrently with the exit wait — a child that fills its pipe's OS
    // buffer before being read would otherwise block on the write and never
    // reach `exited`, defeating the SIGKILL the timeout relies on.
    const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
    const stderrPromise = new Response(proc.stderr).text().catch(() => "");

    if (exitCode === -1) return [];
    if (exitCode !== 0) return [];

    // BUG-2-style: bound the drain. proc.exited resolves when the spawned git
    // exits, NOT when all pipe write-ends close — a grandchild that inherited
    // the write-end keeps the stream open. Mirrors verification/executor.ts
    // (success path): raceWithDeadline caps the drain and a DRAIN_TIMEOUT
    // result becomes "" in the assembled output.
    const [out, err] = await Promise.all([
      raceWithDeadline(stdoutPromise, _fileScanDeps.drainTimeoutMs),
      raceWithDeadline(stderrPromise, _fileScanDeps.drainTimeoutMs),
    ]);
    const stdout = out !== DRAIN_TIMEOUT ? out : "";
    void err; // stderr is uninteresting for file-scan; drain it for the side-effect
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
