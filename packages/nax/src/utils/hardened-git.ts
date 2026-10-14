/** A hardened git call (hardenedGitArgv + gitSpawnEnv) with a SIGKILL timeout. Used by the reviewer guard (nax#2500). */
import { gitSpawnEnv, hardenedGitArgv } from "@nathapp/nax-agent/internal";
import { type SpawnOptions, type SpawnResult, typedSpawn } from "@/utils/bun-deps";

export const _hardenedGitDeps: {
  spawn: (cmd: string[], opts: SpawnOptions) => SpawnResult;
  timeoutMs: number;
} = { spawn: typedSpawn, timeoutMs: 30_000 };

/** Exit code reported for a git killed by the timeout (the `timeout(1)` convention); never a real git exit. */
export const HARDENED_GIT_TIMEOUT_EXIT = 124;

export interface HardenedGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** True when git was killed for exceeding the timeout. */
  readonly timedOut?: boolean;
}

/**
 * Run `git <args>` in `cwd`. The `git` prefix is added here so the `["git", ...]`
 * literal sits at the spawn site (check:git-spawn-env). stdout and stderr are
 * drained concurrently with `proc.exited` so a full pipe cannot deadlock git.
 */
export async function runHardenedGit(args: readonly string[], cwd: string): Promise<HardenedGitResult> {
  const timeoutMs = _hardenedGitDeps.timeoutMs;
  const proc = _hardenedGitDeps.spawn(hardenedGitArgv(["git", ...args]), {
    cwd,
    // Replacement refs a reviewer plants must not rewrite what the guard reads.
    env: gitSpawnEnv({ GIT_NO_REPLACE_OBJECTS: "1" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  // `setTimeout` rather than `Bun.sleep` because the timer must be cancelled
  // once git exits (forbidden-patterns exception: cancellable kill race).
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, timeoutMs);
  const stdoutText = new Response(proc.stdout).text().catch(() => "");
  const stderrText = new Response(proc.stderr).text().catch(() => "");
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (timedOut)
    return {
      stdout: "",
      stderr: `timed out after ${timeoutMs}ms`,
      exitCode: HARDENED_GIT_TIMEOUT_EXIT,
      timedOut: true,
    };
  const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
  return { stdout, stderr, exitCode };
}
