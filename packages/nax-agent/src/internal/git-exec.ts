/**
 * Generic git subprocess execution, shared by nax and the move set. `_gitDeps`
 * is defined here once; `utils/git.ts` re-exports the same object (spec section
 * 4.3), so a test patch through either path affects both halves.
 */

import { getSafeLogger } from "#src/infra/index";
import { runtimeSpawn } from "#src/runtime/index";
import { drainBounded } from "./bounded-io.ts";
import { hardenedGitArgv, hardenedGitEnv } from "./git-env.ts";
import { killProcessGroup } from "./process-kill.ts";

/**
 * Default timeout for git subprocess calls.
 * Prevents git from hanging indefinitely on locked repos or network mounts.
 */
export const GIT_TIMEOUT_MS = 10_000;

/**
 * Timeout for the git subprocesses captureWorkingTreeChanges spawns during
 * timeout-retry recovery. Scoped separately from GIT_TIMEOUT_MS so it doesn't
 * shrink the timeout for unrelated callers (captureOutputFiles, findMergeBase,
 * etc.) — a hung git here must not stall the already-timed-out agent turn.
 */
const TIMEOUT_RETRY_GIT_TIMEOUT_MS = 3_000;

/**
 * Injectable dependencies for git subprocess calls — allows tests to intercept
 * Bun.spawn without mock.module().
 *
 * `gitTimeoutMs` and `timeoutRetryGitTimeoutMs` are injectable so the hang-path
 * tests can assert the SIGKILL contract without burning the full production
 * timeout in wall-clock.
 *
 * @internal
 */
export const _gitDeps = {
  spawn: runtimeSpawn,
  /**
   * The process-group kill (US-001, #2900). A git spawned `detached` leads its
   * own group, so this reaches every helper git started (`git-remote-https`,
   * the alias's shell) rather than only the git pid. Injectable so a
   * fake-spawn test can observe the call without sending a real signal to the
   * pid its fake reported.
   */
  killProcessGroup,
  getSafeLogger,
  gitTimeoutMs: GIT_TIMEOUT_MS,
  timeoutRetryGitTimeoutMs: TIMEOUT_RETRY_GIT_TIMEOUT_MS,
};

/**
 * Return the absolute path of the git repository root for the given workdir.
 * Returns null if workdir is not inside a git repo or the command fails.
 */
export async function getGitRoot(workdir: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await gitWithTimeout(["rev-parse", "--show-toplevel"], workdir);
    if (exitCode !== 0) return null;
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Spawn a git command with a hard timeout.
 *
 * Spawns git `detached`, so git leads its own process group, and SIGKILLs that
 * group (then the git pid) after GIT_TIMEOUT_MS if it hasn't exited — a helper
 * git started can no longer outlive the call.
 * Returns empty stdout and exit code 1 on timeout.
 *
 * `timedOut` is ADDITIVE and OMITTED on every non-timeout return -- every
 * existing caller that destructures `{ stdout, stderr, exitCode }` or asserts
 * on that exact shape is unaffected. It exists because `exitCode === 1` is
 * ambiguous on its own: a timeout collapses to exit code 1 (see below), which
 * is indistinguishable from a real "git said no" exit 1 unless a caller can
 * also see `timedOut`. A caller that treats "not exit 0" as a real, trustworthy
 * answer (e.g. `git check-ignore`'s "not ignored") must check `timedOut` first
 * -- see `partitionNaxOwnedPaths` in `src/tools/git-commit.ts`.
 *
 * @internal
 */
export async function gitWithTimeout(
  args: string[],
  workdir: string,
  timeoutMs: number = _gitDeps.gitTimeoutMs,
  maxBytes?: number,
  /** Full argv INCLUDING argv[0]. Callers that must control argv[0] pass this;
   *  everyone else gets ["git", ...args] as before. */
  argvOverride?: readonly string[],
  envOverlay?: Readonly<Record<string, string>>,
  /** Aborting kills the git child; the result is then a non-zero exit with `aborted: true`. */
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean; aborted?: boolean }> {
  const proc = _gitDeps.spawn(hardenedGitArgv(argvOverride ?? ["git", ...args]), {
    cwd: workdir,
    env: hardenedGitEnv(envOverlay === undefined ? process.env : { ...process.env, ...envOverlay }),
    stdout: "pipe",
    stderr: "pipe",
    // setsid(): the git pid becomes the leader of a new process group, so the
    // group kill below reaches every helper git spawned. Without it a killed
    // `git push` leaves `git-remote-https` doing network work after nax has
    // reported the call cancelled (US-001, #2900). A detached git has no
    // controlling terminal, so a prompt ssh would read from /dev/tty fails at
    // once instead of waiting on the terminal.
    detached: true,
  });

  let timedOut = false;
  /**
   * Stop git and everything git started. Two kills, each independently
   * contained (US-001, #2900):
   * - the process group, with no single-process fallback: the git pid may be
   *   reused once git has exited;
   * - the git pid itself, which is the only reach where process groups do not
   *   exist (Windows: `process.kill(-pid)` fails with a non-ESRCH error that
   *   the group kill reports as sent) and which keeps `proc.killed` true.
   */
  const kill = (): void => {
    try {
      _gitDeps.killProcessGroup(proc.pid, "SIGKILL", { singleProcessFallback: false });
    } catch {
      // Group kills are unavailable or already exited; the direct kill below stays.
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process may have already exited
    }
  };
  const onAbort = (): void => kill();
  if (signal?.aborted) kill();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timerId = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  // Drain stdout/stderr concurrently with awaiting exit — a process that fills
  // either pipe's OS buffer (>64KB) before being read would otherwise block on
  // the write and never reach `exited`, defeating the timeout's own SIGKILL.
  // `.catch()` is attached eagerly: on the timeout path below we return without
  // awaiting these, and an unawaited rejection (a SIGKILLed process can error its
  // pipes) would surface as an unhandled rejection and take the process down.
  // `maxBytes` bounds the WORK, not just the answer: the timeout caps wall
  // clock, so without it `git log -p` on a large repository can accumulate for
  // as long as the timeout allows. Optional, and unbounded when absent, so the
  // callers that read a single ref keep exactly their current behaviour.
  const drain = (stream: ReadableStream<Uint8Array>): Promise<string> =>
    (maxBytes === undefined ? new Response(stream).text() : drainBounded(stream, maxBytes)).catch(() => "");
  const stdoutPromise = drain(proc.stdout);
  const stderrPromise = drain(proc.stderr);

  const exitCode = await proc.exited;
  clearTimeout(timerId);
  signal?.removeEventListener("abort", onAbort);

  if (timedOut) {
    // Don't await the drain promises here — a SIGKILL'd process's pipes may
    // never close in test mocks (and are irrelevant either way since the
    // output is discarded), so awaiting them could re-introduce a hang on
    // the very path this timeout exists to bound.
    return { stdout: "", stderr: "", exitCode: 1, timedOut: true };
  }

  if (signal?.aborted) {
    // Same reason as the timeout: even with the group killed, a pipe a helper
    // held open (`git push` hands its pipes to `git-remote-https`) may not have
    // closed yet, and the output is discarded either way.
    return { stdout: "", stderr: "", exitCode: 1, aborted: true };
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { stdout, stderr, exitCode };
}
