/**
 * Run an argv with no shell, a deadline, and a process-group kill.
 *
 * Extracted from worktree/dependencies.ts so its two callers cannot drift.
 * The three behaviours here were each a defect once and must not be rewritten
 * from scratch: MEM-4 (a postinstall grandchild survived proc.kill() and kept
 * running against a deleted worktree), BUG-13 (a hung install had no deadline),
 * and the concurrent drain (a child that fills a pipe buffer never reaches
 * `exited`, defeating the timeout).
 *
 * US-001 adds three more invariants on the same shape:
 * - `signal?: AbortSignal` aborts the process group and reports `aborted`.
 * - An already-aborted signal never spawns and resolves with exitCode -1.
 * - After `exited`, both readers get `DRAIN_GRACE_MS` to close; if either
 *   stays open, the group is SIGKILLed and `orphansKilled: true` is set with
 *   whatever the readers captured so far.
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
  /**
   * When aborted, the process group is SIGKILLed, both readers are cancelled
   * and the result resolves with `aborted: true`. US-001.
   */
  readonly signal?: AbortSignal;
}

export interface ArgvExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when an abort killed the process group. Always set by runArgv. */
  readonly aborted?: boolean;
  /** True when background processes holding a stream were SIGKILLed on drain. Always set by runArgv. */
  readonly orphansKilled?: boolean;
}

/**
 * Time, in milliseconds, the readers are allowed to drain after `exited`
 * before runArgv SIGKILLs the whole group and reports `orphansKilled`. US-001.
 * Injectable for tests; not exposed as user configuration.
 */
export const DRAIN_GRACE_MS = 500;

/** Injectable seam, mirroring _worktreeDependencyDeps. */
export const _argvExecDeps = {
  spawn,
  killProcessGroup,
  /**
   * The post-exit drain grace (US-001). A real test can shrink it to keep the
   * "background process holding the pipe" case under a second; production
   * stays at the DRAIN_GRACE_MS constant.
   */
  drainGraceMs: DRAIN_GRACE_MS,
  /**
   * Injectable timer pair — lets the BUG-13 "hung install" test drive the
   * timeout off a virtual clock instead of waiting the full 1s schema minimum.
   * Mirrors `_heartbeatDeps` / `_idleWatchdogDeps` / `_authDeps`.
   *
   * @internal
   */
  setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)) as (id: unknown) => void,
};

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

interface StreamDrain {
  text: string;
  closed: boolean;
}

/**
 * Read a ReadableStream<Uint8Array> to EOF, accumulating text. Resolves when
 * the stream closes (done). The caller races this against a wall-clock
 * deadline to detect an open-after-exit pipe (the `&`ed background case).
 *
 * `Response.text()` doesn't honour a deadline, so the reader is its own
 * function (US-001 "Read stdout and stderr incrementally/concurrently").
 *
 * When `signal` aborts, the reader is cancelled so the pending `read()`
 * resolves with `{done: true}`. The caller uses this to bound settlement
 * after a process-group kill: a child that ignores the kill cannot pin
 * runArgv forever on its still-open pipe.
 */
async function drainToEof(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<StreamDrain> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const onAbort = (): void => {
    // Closing the stream forces the in-flight `read()` below to resolve with
    // `{done: true}`; any bytes already captured stay in `text`.
    reader.cancel().catch(() => {
      // Cancelling after the pipe already closed is a no-op race; ignore.
    });
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done === true) break;
      if (value !== undefined) text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Stream cancelled by SIGKILL on the process group; the partial text
    // is still in `text`, so resolve with closed=false and let the caller
    // decide.
  }
  text += decoder.decode();
  if (signal !== undefined) signal.removeEventListener("abort", onAbort);
  try {
    reader.releaseLock();
  } catch {
    // Already released; nothing to do.
  }
  return { text, closed: true };
}

export async function runArgv(options: RunArgvOptions): Promise<ArgvExecResult> {
  const signal = options.signal;
  // Already-aborted signal: never spawn. The caller gets `aborted: true` with
  // a sentinel exitCode so a misread of the field can't masquerade as a real
  // process completing (US-001 AC7).
  if (signal?.aborted === true) {
    return { exitCode: -1, stdout: "", stderr: "", timedOut: false, aborted: true, orphansKilled: false };
  }

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

  let timedOut = false;
  let aborted = false;
  let orphansKilled = false;

  const killGroup = (): void => {
    _argvExecDeps.killProcessGroup(proc.pid, "SIGKILL");
  };

  const stdoutController = new AbortController();
  const stderrController = new AbortController();
  const stopReaders = (): void => {
    stdoutController.abort();
    stderrController.abort();
  };

  // BUG-13: unlike every git call (routed through gitWithTimeout), a spawn
  // with no deadline can block its caller forever on a hung install
  // (registry/NFS stall).
  const timerId = _argvExecDeps.setTimeout(() => {
    timedOut = true;
    // MEM-4: proc.kill() reaches only the direct child, orphaning postinstall
    // grandchildren. killProcessGroup(pid, "SIGKILL") kills the whole group
    // (negative pid), falling back to the single process on ESRCH.
    killGroup();
    stopReaders();
  }, options.timeoutMs);

  // US-001: an abort races the timeout. One listener, removed on every settle
  // path so a never-aborted signal never leaks a registration (AC10).
  const onAbort = (): void => {
    aborted = true;
    killGroup();
    stopReaders();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // Read stdout/stderr concurrently with the exit wait — a process that
  // fills a pipe's OS buffer before being read would otherwise block on the
  // write and never reach `exited`, defeating the timeout's own SIGKILL.
  // Each reader has its own controller so a still-pending one can be forced
  // to settle (via reader.cancel()) after we kill the process group. US-001
  // requires that settlement stay bounded even when a background process
  // inherits the pipe and ignores the SIGKILL.
  const stdoutPromise = drainToEof(proc.stdout, stdoutController.signal);
  const stderrPromise = drainToEof(proc.stderr, stderrController.signal);
  const exitCode = await proc.exited;

  // Post-exit drain grace. After exit, the streams MUST close — they were
  // owned by the shell, which is now dead. Background processes that
  // inherited the pipe (the `&` case) keep it open: that's the orphan.
  const graceMs = _argvExecDeps.drainGraceMs;
  // Cleared on every settle path: a successful command whose readers close
  // before the grace elapses would otherwise leave a pending timer whose
  // callback fires 500ms later and resolves an orphaned promise. Under load
  // the leaked registrations accumulate in the timer wheel for nothing.
  let graceTimerId: unknown;
  const gracePromise = new Promise<"expired">((resolve) => {
    graceTimerId = _argvExecDeps.setTimeout(() => resolve("expired"), graceMs);
  });
  const stdoutSettled = await Promise.race([
    stdoutPromise,
    gracePromise.then((): StreamDrain | "expired" => "expired"),
  ]);
  const stderrSettled = await Promise.race([
    stderrPromise,
    gracePromise.then((): StreamDrain | "expired" => "expired"),
  ]);
  if (graceTimerId !== undefined) _argvExecDeps.clearTimeout(graceTimerId);

  const stdoutClosed = stdoutSettled !== "expired";
  const stderrClosed = stderrSettled !== "expired";

  if (!stdoutClosed || !stderrClosed) {
    orphansKilled = true;
    killGroup();
    // The OS should close the pipes once the group dies; race that against
    // a small post-kill budget. If a holdout somehow ignores SIGKILL or is
    // not yet reaped, abort the matching reader controller — that drives
    // `reader.cancel()` in drainToEof, which forces the pending `read()` to
    // resolve with `done: true` and bounds settlement.
    if (!stdoutClosed) stdoutController.abort();
    if (!stderrClosed) stderrController.abort();
  }

  // Always await the readers to harvest whatever they captured.
  const stdoutFinal = stdoutClosed ? (stdoutSettled as StreamDrain) : await stdoutPromise;
  const stderrFinal = stderrClosed ? (stderrSettled as StreamDrain) : await stderrPromise;

  _argvExecDeps.clearTimeout(timerId);
  signal?.removeEventListener("abort", onAbort);

  return {
    exitCode,
    stdout: stdoutFinal.text,
    stderr: stderrFinal.text,
    timedOut,
    aborted,
    orphansKilled,
  };
}
