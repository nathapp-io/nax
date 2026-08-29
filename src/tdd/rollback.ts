import { rm } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { autoCommitIfDirty, getGitRoot, getUntrackedPaths } from "../utils/git";
import { killProcessGroup } from "../utils/process-kill";

/**
 * Hard deadline on the bare git subprocesses in this module (`git reset --hard`
 * and `git rev-parse HEAD`). Every other git call in this file already routes
 * through `gitWithTimeout` in `src/utils/git.ts`; these two were the last
 * unbounded git spawns in the TDD rollback path (a wedged git could stall a
 * story's rollback / snapshot indefinitely). Mirrors the SIGKILL-after-timeout
 * pattern from `gitWithTimeout`, `_isolationDeps.timeoutMs`, and
 * `worktree/dependencies.ts`. Tests inject a short value via
 * `_rollbackDeps.timeoutMs`.
 */
const ROLLBACK_GIT_TIMEOUT_MS = 10_000;

export const _rollbackDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
  killProcessGroup,
  autoCommitIfDirty,
  getUntrackedPaths,
  getGitRoot,
  rm,
  timeoutMs: ROLLBACK_GIT_TIMEOUT_MS,
};

/**
 * Run a single git argv with a hard SIGKILL-after-timeout deadline so a wedged
 * git cannot stall the caller indefinitely. On timeout, the whole process group
 * is killed and the helper resolves with `{ timedOut: true, exitCode: -1, stderr: "", stdout: "" }`
 * — the caller treats that as a rollback / snapshot failure and surfaces the
 * appropriate error.
 *
 * The deadline is enforced by a `settled` flag the timer resolves directly —
 * we do NOT rely on SIGKILL causing `proc.exited` to settle, because that
 * side-effect is an implementation detail of the child and not part of the
 * contract this helper guarantees. Mirrors the defensive `awaitProcExit` shape
 * from `src/execution/pid-registry.ts` rather than `gitWithTimeout`'s
 * weaker "trust the kill signal" form, so AC-3 / AC-4 hold even when the child
 * does not reap its own exited promise after the OS sends SIGKILL.
 */
async function runGitBounded(
  args: string[],
  workdir: string,
): Promise<{ exitCode: number; stderr: string; stdout: string; timedOut: boolean }> {
  const proc = _rollbackDeps.spawn(["git", ...args], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Drain concurrently with the exit wait — a child that fills its pipe's OS
  // buffer before being read would otherwise block on the write and never
  // reach `exited`, defeating the SIGKILL the timeout relies on.
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  let timedOut = false;
  let exitCode = -1;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      exitCode = code;
      resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        _rollbackDeps.killProcessGroup(proc.pid, "SIGKILL");
      } catch {
        // Process may have already exited; the deadline below still wins.
      }
      finish(-1);
    }, _rollbackDeps.timeoutMs);
    proc.exited.then(finish, () => finish(-1));
  });

  if (timedOut) {
    return { exitCode: -1, stderr: "", stdout: "", timedOut: true };
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { exitCode, stderr, stdout, timedOut: false };
}

/**
 * Rollback git changes to a specific ref.
 *
 * `untrackedBefore` is a snapshot of untracked paths taken at phase start
 * (before the agent ran) — see `getUntrackedPaths`. Rollback deletes only the
 * untracked paths that appeared SINCE that snapshot (BUG-07): a blanket
 * `git clean -fd` would also delete untracked files that predate the phase —
 * the user's `.env`, WIP notes — which have nothing to do with the agent's
 * failed attempt. Paths already untracked at snapshot time are left alone.
 *
 * `untrackedBefore` is `null` when the baseline snapshot itself failed (git
 * error/timeout) — an unknown baseline is never treated as an empty one, so
 * the untracked cleanup is skipped entirely rather than risk deleting files
 * that predate the phase. Same rule applies if the post-reset snapshot fails.
 */
export async function rollbackToRef(workdir: string, ref: string, untrackedBefore: string[] | null): Promise<void> {
  const logger = getLogger();
  logger.warn("tdd", "Rolling back git changes", { ref });

  const { exitCode, stderr, timedOut } = await runGitBounded(["reset", "--hard", ref], workdir);
  if (timedOut) {
    logger.error("tdd", "Git rollback timed out — wedged git killed", {
      ref,
      timeoutMs: _rollbackDeps.timeoutMs,
    });
    // AC-3: the rollback surface must reject with a plain Error (not NaxError),
    // and its message must name the rollback failure so the verdict path's
    // existing error-classification logic sees what it expects.
    throw new Error(`Git rollback failed: timed out after ${_rollbackDeps.timeoutMs}ms`); // nax-lint-allow: plain-error
  }
  if (exitCode !== 0) {
    logger.error("tdd", "Failed to rollback git changes", { ref, stderr });
    throw new Error(`Git rollback failed: ${stderr}`);
  }

  if (untrackedBefore === null) {
    logger.warn("tdd", "Untracked-paths baseline unavailable — skipping untracked cleanup", { ref });
  } else {
    const untrackedNow = await _rollbackDeps.getUntrackedPaths(workdir);
    if (untrackedNow === null) {
      logger.warn("tdd", "Post-reset untracked-paths read failed — skipping untracked cleanup", { ref });
    } else {
      const before = new Set(untrackedBefore);
      const appearedSincePhaseStart = untrackedNow.filter((p) => !before.has(p));
      // Porcelain paths are always repo-root-relative, independent of the cwd git
      // was spawned from — resolve against the real git root, not `workdir` (which
      // may be a package subdirectory in a monorepo), or the join silently misses.
      const root = (await _rollbackDeps.getGitRoot(workdir)) ?? workdir;

      for (const relPath of appearedSincePhaseStart) {
        try {
          await _rollbackDeps.rm(join(root, relPath), { recursive: true, force: true });
        } catch (err) {
          logger.warn("tdd", "Failed to clean untracked file", {
            path: relPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info("tdd", "Untracked cleanup complete", { ref, untrackedCleaned: appearedSincePhaseStart.length });
    }
  }

  logger.info("tdd", "Successfully rolled back git changes", { ref });
}

export interface SnapshotRef {
  sha: string;
  /** Untracked paths present right after the commit — the BUG-07 rollback baseline. `null` if the read failed. */
  untrackedBefore: string[] | null;
}

/**
 * Capture the current (adversarial-passed) state as a restorable commit ref
 * (ADR-024 non-blocking-fix entry snapshot). Commits any uncommitted/untracked
 * story changes so they are TRACKED, then returns the resulting HEAD SHA plus
 * an untracked-paths snapshot for `rollbackToRef`'s BUG-07 diff-based clean.
 * Restore via rollbackToRef(workdir, sha, untrackedBefore).
 */
export async function captureSnapshotRef(workdir: string, storyId: string): Promise<SnapshotRef> {
  await _rollbackDeps.autoCommitIfDirty(workdir, "non-blocking-fix-snapshot", "snapshot", storyId);
  const { exitCode, stdout, timedOut } = await runGitBounded(["rev-parse", "HEAD"], workdir);
  if (timedOut) {
    throw new NaxError(
      `git rev-parse HEAD timed out after ${_rollbackDeps.timeoutMs}ms in non-blocking-fix snapshot`,
      "SNAPSHOT_REF_FAILED",
      { storyId, workdir, stage: "non-blocking-fix-snapshot", timeoutMs: _rollbackDeps.timeoutMs },
    );
  }
  if (exitCode !== 0) {
    throw new NaxError("git rev-parse HEAD failed in non-blocking-fix snapshot", "SNAPSHOT_REF_FAILED", {
      storyId,
      workdir,
      stage: "non-blocking-fix-snapshot",
    });
  }
  const untrackedBefore = await _rollbackDeps.getUntrackedPaths(workdir);
  return { sha: stdout.trim(), untrackedBefore };
}
