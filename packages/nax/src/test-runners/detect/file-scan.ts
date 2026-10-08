/**
 * Tier 3 — File System Scan
 *
 * Walks `git ls-files` output, counts files against a table of candidate
 * test-file matchers (a basename suffix, or a basename prefix such as pytest's
 * `test_*.py`), and emits the glob of each candidate meeting a count threshold.
 *
 * Threshold: a candidate reports when ≥5 files match OR ≥10% of total files.
 * Excluded: node_modules/, dist/, build/, .nax/, coverage/, .git/
 */

import { gitSpawnEnv, killProcessGroup } from "@nathapp/nax-agent/internal";
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

/** Min file count to consider a candidate a test-file indicator */
const MIN_COUNT_THRESHOLD = 5;
/** Min fraction of all files to consider a candidate a test-file indicator */
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

/** A test-file naming convention the scan counts, and the glob it reports when it wins. */
interface Candidate {
  readonly glob: string;
  readonly matches: (path: string) => boolean;
}

const bySuffix = (suffix: string): Candidate => ({
  glob: `**/*${suffix}`,
  matches: (path) => path.endsWith(suffix),
});

/** pytest's default: the marker is a basename PREFIX, so a suffix test can never see it. */
const byBasenamePrefix = (prefix: string, extension: string): Candidate => ({
  glob: `**/${prefix}*${extension}`,
  matches: (path) => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base.startsWith(prefix) && base.endsWith(extension) && base.length > prefix.length + extension.length;
  },
});

/** Common test-file conventions, in report order. */
const CANDIDATES: readonly Candidate[] = [
  bySuffix(".test.ts"),
  bySuffix(".test.tsx"),
  bySuffix(".test.js"),
  bySuffix(".test.jsx"),
  bySuffix(".spec.ts"),
  bySuffix(".spec.tsx"),
  bySuffix(".spec.js"),
  bySuffix(".spec.jsx"),
  bySuffix(".e2e-spec.ts"),
  bySuffix(".e2e-spec.js"),
  bySuffix("_test.go"),
  bySuffix("_test.py"),
  byBasenamePrefix("test_", ".py"),
];

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
      env: gitSpawnEnv(),
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

    // Start draining concurrently with the exit wait — a child that fills its
    // pipe's OS buffer before being read would otherwise block on the write
    // and never reach `exited`, defeating the SIGKILL the timeout relies on.
    // Must be created BEFORE the exit race below, not after: `new
    // Response(stream).text()` begins consuming the stream as soon as it is
    // constructed, so creating it only after `proc.exited` settles leaves the
    // pipe unread for the whole race window.
    const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
    const stderrPromise = new Response(proc.stderr).text().catch(() => "");

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
 * Scan git-tracked files and detect test-file patterns by candidate-match frequency.
 * Returns null when no candidates meet the threshold.
 */
export async function detectFromFileScan(workdir: string): Promise<DetectionSource | null> {
  const files = await gitLsFiles(workdir);
  const filtered = files.filter((f) => !isExcluded(f));

  if (filtered.length === 0) return null;

  const totalFiles = filtered.length;
  const patterns = CANDIDATES.filter((candidate) => {
    const count = filtered.filter((file) => candidate.matches(file)).length;
    return count > 0 && (count >= MIN_COUNT_THRESHOLD || count / totalFiles >= MIN_FRACTION_THRESHOLD);
  }).map((candidate) => candidate.glob);

  if (patterns.length === 0) return null;

  return {
    type: "file-scan",
    path: workdir,
    patterns,
  };
}
