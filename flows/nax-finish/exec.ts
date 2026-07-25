/**
 * Subprocess execution for the nax-finish flow.
 *
 * Two distinct entry points, deliberately:
 *
 * - `runArgv` — for commands *this flow* constructs (`git`, `gh`, `glab`). An
 *   argv array is spawned directly: no shell, so no quoting or injection
 *   surface for branch names and review text.
 * - `runShell` — for command *strings the user configured* (`quality.commands`,
 *   `acceptance.command`). These are run through `/bin/sh -c`, matching
 *   `src/quality/runner.ts`, which is the only way to preserve `&&`, quoting,
 *   globs and env prefixes. Splitting such a string on whitespace and spawning
 *   argv (the previous behaviour) silently mis-ran every non-trivial command.
 *
 * Both cap wall-clock time: an unbounded gate would hang `acpx flow run`, and
 * the post-run plugin awaits that subprocess.
 */
import type { RunResult } from "./types";

/** Fallbacks used when the plugin passes no explicit budget in the flow input. */
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 600_000;
export const DEFAULT_GATE_TIMEOUT_MS = 900_000;
/** Short budget for the flow's own git/forge plumbing — these are never long-running. */
export const DEFAULT_ARGV_TIMEOUT_MS = 120_000;

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
}

async function spawnCapture(cmd: string[], opts: ExecOptions): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  // setTimeout (not Bun.sleep) because the handle must be cancellable the moment
  // the process exits — the documented exception in forbidden-patterns.md.
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, opts.timeoutMs)
      : undefined;
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return timedOut
      ? {
          exitCode: exitCode === 0 ? 124 : exitCode,
          stdout,
          stderr: `${stderr}\n[nax-finish] killed after ${opts.timeoutMs}ms timeout`,
          timedOut: true,
        }
      : { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Spawn an argv array directly — no shell. For flow-constructed commands. */
export function runArgv(cmd: string[], opts: ExecOptions): Promise<RunResult> {
  return spawnCapture(cmd, { ...opts, timeoutMs: opts.timeoutMs ?? DEFAULT_ARGV_TIMEOUT_MS });
}

/** Run a configured command string through `/bin/sh -c`, preserving shell semantics. */
export function runShell(command: string, opts: ExecOptions): Promise<RunResult> {
  return spawnCapture(["/bin/sh", "-c", command], opts);
}
