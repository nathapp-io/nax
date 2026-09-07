/**
 * Run an argv with no shell, a deadline, and a process-group kill.
 *
 * Extracted from worktree/dependencies.ts so its two callers cannot drift.
 * The three behaviours here were each a defect once and must not be rewritten
 * from scratch: MEM-4 (a postinstall grandchild survived proc.kill() and kept
 * running against a deleted worktree), BUG-13 (a hung install had no deadline),
 * and the concurrent drain (a child that fills a pipe buffer never reaches
 * `exited`, defeating the timeout).
 */
import { spawn } from "./bun-deps";
import { killProcessGroup } from "./process-kill";

export interface RunArgvOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stripEnvVars?: readonly string[];
  /**
   * Overlay applied on top of process.env, after stripping.
   *
   * Yarn 2+ has no --ignore-scripts option and honours the enableScripts
   * setting instead, overridable per invocation by YARN_ENABLE_SCRIPTS. So the
   * no-scripts mechanism is a flag for some managers and an environment
   * variable for others, and both must be nax-supplied.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ArgvExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Injectable seam, mirroring _worktreeDependencyDeps. */
export const _argvExecDeps = { spawn, killProcessGroup };

/**
 * Build the child's env only when the caller actually asked for stripping or
 * an overlay. Leaving it `undefined` otherwise means `Bun.spawn` inherits
 * `process.env` on its own, which is both the cheaper path and what every
 * caller without those options already relied on before this seam existed.
 */
function buildEnv(options: RunArgvOptions): Record<string, string | undefined> | undefined {
  const hasStrip = (options.stripEnvVars?.length ?? 0) > 0;
  const hasOverlay = options.env !== undefined && Object.keys(options.env).length > 0;
  if (!hasStrip && !hasOverlay) return undefined;

  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of options.stripEnvVars ?? []) delete env[name];
  Object.assign(env, options.env ?? {});
  return env;
}

export async function runArgv(options: RunArgvOptions): Promise<ArgvExecResult> {
  const env = buildEnv(options);

  const proc = _argvExecDeps.spawn([...options.argv], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env !== undefined ? { env } : {}),
    // MEM-4: setsid() makes this pid the process-group id, so a group kill
    // reaches grandchildren (a package manager's postinstall) rather than only
    // the direct child.
    detached: true,
  });

  // BUG-13: unlike every git call (routed through gitWithTimeout), a spawn
  // with no deadline can block its caller forever on a hung install
  // (registry/NFS stall).
  let timedOut = false;
  const timerId = setTimeout(() => {
    timedOut = true;
    // MEM-4: proc.kill() reaches only the direct child, orphaning postinstall
    // grandchildren. killProcessGroup(pid, "SIGKILL") kills the whole group
    // (negative pid), falling back to the single process on ESRCH.
    _argvExecDeps.killProcessGroup(proc.pid, "SIGKILL");
  }, options.timeoutMs);

  // Drain concurrently with the exit wait — a process that fills a pipe's OS
  // buffer before being read would otherwise block on the write and never
  // reach `exited`, defeating the timeout's own SIGKILL.
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  const exitCode = await proc.exited;
  clearTimeout(timerId);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  return { exitCode, stdout, stderr, timedOut };
}
