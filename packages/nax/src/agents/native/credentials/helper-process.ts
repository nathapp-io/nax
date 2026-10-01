/**
 * The exec helper's process boundary (US-003): spawn it, feed it one request
 * line, bound both streams, and report what came back.
 *
 * Nothing here chooses a credential error code — that mapping belongs to
 * exec-source.ts. What this module owns is the deadline, the stdout cap, the
 * bounded drain after the process is gone, and the secrecy rule: stderr is
 * redacted *before* it is truncated, so truncation can never cut a secret into a
 * fragment the redaction patterns no longer recognise.
 */

import { getSafeLogger } from "@/agents/infra";
import { errorMessage } from "@/utils/errors";
import { redactSecrets } from "@/utils/redact";
import { HELPER_SUBCOMMAND, requestLine } from "./helper-protocol";

/**
 * Hard cap on the helper's stdout. Over it the reply is malformed and the
 * process is killed. Not configurable (US-003 scope).
 */
export const AUTH_HELPER_STDOUT_MAX_BYTES = 65_536;

/** Hard cap on the stderr excerpt that may reach a log line or an error message. */
export const AUTH_HELPER_STDERR_MAX_BYTES = 4_096;

/**
 * How much stderr is collected before further bytes are dropped. Redaction runs
 * over the whole collected prefix and only AUTH_HELPER_STDERR_MAX_BYTES of the
 * result is kept, so the 8× margin leaves a secret that straddles the
 * truncation point fully visible to the redaction patterns.
 */
const AUTH_HELPER_STDERR_COLLECT_MAX_BYTES = AUTH_HELPER_STDERR_MAX_BYTES * 8;

/**
 * How long the readers may keep waiting once the process is gone. A helper's
 * pipes close the instant it exits; only an inherited pipe — a descendant of a
 * killed helper, such as the `sleep` or the network client it shelled out to —
 * outlives it, and that one will never end on its own.
 */
const DRAIN_GRACE_MS = 500;

/** The slice of Bun's Subprocess this module uses. */
interface HelperProcess {
  readonly stdin: { write(data: string): unknown; end(): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  /**
   * Always SIGKILL. A deadline that a helper can ignore is not a deadline: the
   * call would wait on a process that never exits, and `read` would never settle.
   */
  kill(signal: "SIGKILL"): void;
}

/**
 * Injectable seam (the `_deps` pattern): every external call this module makes
 * goes through it, so a test can drive the helper without a real process.
 *
 * The spawn deliberately passes no `env`: the child inherits nax's environment,
 * which is what the helper contract promises.
 */
export const _execSourceDeps = {
  spawn: (argv: readonly string[]): HelperProcess =>
    // nax-git-env-allow: caller-supplied helper argv, not git; the child inherits nax's env by contract
    Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as HelperProcess,
  /**
   * Timer pair, wrapped so the global functions are resolved per call — a test
   * that spies on `setTimeout` (the timer-leak helper) still sees these.
   */
  setTimeout: ((fn: () => void, ms: number): unknown => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>)) as (id: unknown) => void,
};

/** What one helper invocation produced, as the process boundary saw it. */
export type HelperProcessResult =
  | { kind: "spawn-failed"; detail: string; cause: unknown; stderr: string }
  | { kind: "timed-out"; detail: string; stderr: string }
  | { kind: "stdout-over-cap"; detail: string; stderr: string }
  /** No reply to judge: the process was killed, or its streams failed under us. */
  | { kind: "no-answer"; detail: string; stderr: string }
  | { kind: "exited"; exitCode: number; stdout: string; stderr: string };

/** Bytes read from a stream, and whether its cap was passed while reading it. */
interface StreamRead {
  text: string;
  exceeded: boolean;
}

/** How a stream read is bounded, and how it can be abandoned. */
interface ReadCappedOptions {
  /** Called once the stream passes `cap`, before reading stops. */
  onExceeded?: () => void;
  /** Cancels the pending read, for a stream that will never close on its own. */
  signal?: AbortSignal;
}

/**
 * Read a stream to EOF, decoding UTF-8.
 *
 * Reads run concurrently with the exit wait: a child that fills the OS pipe
 * buffer before anyone reads it would otherwise block on its own write and never
 * reach `exited`, which would leave the timeout as the only way out.
 *
 * Past `cap` the two callers differ. With `onExceeded` the stream is abandoned —
 * the callback kills the process, so there is nothing left to drain. Without it
 * the stream is still drained (a full pipe must not wedge the child) but nothing
 * more is kept.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  options: ReadCappedOptions = {},
): Promise<StreamRead> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let exceeded = false;

  /** Abort closes the stream, which resolves the pending `read()` with `done`. */
  const onAbort = (): void => {
    reader.cancel().catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done === true) break;
      if (value === undefined) continue;

      bytes += value.byteLength;
      if (bytes > cap && !exceeded) {
        exceeded = true;
        if (options.onExceeded !== undefined) {
          options.onExceeded();
          // The process is dying; do not wait for its pipe to notice.
          await reader.cancel().catch(() => {});
          break;
        }
      }
      if (!exceeded) text += decoder.decode(value, { stream: true });
    }
  } catch {
    // The pipe closed under us — a kill, an abort, or a child that exited
    // mid-write. Whatever was collected before that still stands.
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (!exceeded) text += decoder.decode();
  return { text, exceeded };
}

/** Write the one-line request, then close stdin so the helper sees EOF. */
function writeRequest(proc: HelperProcess, providerId: string): void {
  try {
    proc.stdin.write(requestLine(providerId));
    proc.stdin.end();
  } catch (cause) {
    // A helper that exits without draining stdin surfaces EPIPE here. Its exit
    // code is the verdict, so this is a diagnostic, not a failure of its own.
    getSafeLogger()?.debug("credentials", "credential.helper_stdin_failed", {
      providerId,
      error: errorMessage(cause),
    });
  }
}

/** Both streams of one helper call, and the controllers that can cancel them. */
interface HelperStreams {
  stdout: Promise<StreamRead>;
  stderr: Promise<StreamRead>;
  controllers: readonly AbortController[];
}

/**
 * Collect both streams, bounded by DRAIN_GRACE_MS once the process has exited.
 *
 * A helper's pipes close as it exits — unless it left a descendant holding them,
 * and a killed helper leaves exactly that whenever it shelled out. That pipe
 * never closes on its own, so it must not be allowed to hold the read past the
 * deadline the source promises: whatever arrived within the grace is kept, and
 * the rest is abandoned.
 */
async function drainStreams(streams: HelperStreams): Promise<[StreamRead, StreamRead]> {
  let graceTimer: unknown;
  const grace = new Promise<null>((resolve) => {
    graceTimer = _execSourceDeps.setTimeout(() => resolve(null), DRAIN_GRACE_MS);
  });

  try {
    const drained = await Promise.race([Promise.all([streams.stdout, streams.stderr]), grace]);
    if (drained !== null) return drained;
    for (const controller of streams.controllers) controller.abort();
    return await Promise.all([streams.stdout, streams.stderr]);
  } finally {
    // Cleared on both paths: an armed timer outliving the call keeps the event
    // loop alive after the read has already resolved.
    _execSourceDeps.clearTimeout(graceTimer);
  }
}

/** What one helper process produced, before it is interpreted. */
interface ProcessRun {
  /** Which kill switch fired first, if either did. */
  trip: "timeout" | "cap" | undefined;
  /** `null` when a signal killed the process, so there is no exit code to report. */
  exitCode: number | null;
  stdout: StreamRead;
  stderr: string;
}

/**
 * SIGKILL a helper, tolerating a child that is already gone.
 *
 * A deadline that a helper can ignore is not a deadline: the call would wait on
 * a process that never exits, and `read` would never settle. The `try` is for the
 * race where the child is reaped between the decision to kill it and the signal.
 */
function killHelper(proc: HelperProcess): void {
  try {
    proc.kill("SIGKILL");
  } catch {
    // The child was already gone; its exit code decides the outcome either way.
  }
}

/** Run one helper process to its end, killing it if either kill switch trips first. */
async function runHelperProcess(proc: HelperProcess, providerId: string, timeoutMs: number): Promise<ProcessRun> {
  // Whichever trips first decides the outcome; both kill the process.
  let trip: "timeout" | "cap" | undefined;
  const timer = _execSourceDeps.setTimeout(() => {
    if (trip === undefined) trip = "timeout";
    killHelper(proc);
  }, timeoutMs);

  const stdoutController = new AbortController();
  const stderrController = new AbortController();

  try {
    writeRequest(proc, providerId);
    // Reading starts here, concurrently with the exit wait below.
    const streams: HelperStreams = {
      stdout: readCapped(proc.stdout, AUTH_HELPER_STDOUT_MAX_BYTES, {
        signal: stdoutController.signal,
        onExceeded: () => {
          if (trip === undefined) trip = "cap";
          killHelper(proc);
        },
      }),
      stderr: readCapped(proc.stderr, AUTH_HELPER_STDERR_COLLECT_MAX_BYTES, { signal: stderrController.signal }),
      controllers: [stdoutController, stderrController],
    };

    await proc.exited;
    const [stdout, stderr] = await drainStreams(streams);
    return { trip, exitCode: proc.exitCode, stdout, stderr: stderr.text };
  } finally {
    // Cleared however the call ends, including the timeout: a timer left armed
    // holds the event loop open after the read has already resolved.
    _execSourceDeps.clearTimeout(timer);
  }
}

/** Spawn the helper for `providerId` and report what it produced. Never throws for a helper failure. */
export async function runHelper(
  command: readonly string[],
  providerId: string,
  timeoutMs: number,
): Promise<HelperProcessResult> {
  let proc: HelperProcess;
  try {
    // nax-git-env-allow: caller-supplied helper argv, not git; the child inherits nax's env by contract
    proc = _execSourceDeps.spawn([...command, HELPER_SUBCOMMAND]);
  } catch (cause) {
    // A missing binary never reaches `exited`: Bun throws ENOENT from spawn.
    return { kind: "spawn-failed", detail: `could not be started: ${errorMessage(cause)}`, cause, stderr: "" };
  }

  let run: ProcessRun;
  try {
    run = await runHelperProcess(proc, providerId, timeoutMs);
  } catch (cause) {
    // The streams or the exit wait failed under us, so nothing was learned about
    // the provider. The child is NOT necessarily dead, though: the `finally` in
    // runHelperProcess has already cleared the deadline timer that would have
    // killed it, and that call's abort controllers died with the throw. Left
    // alone it runs until it chooses to stop, holding two open pipes. Kill it
    // and drop the readers here, where `proc` is still in scope.
    killHelper(proc);
    await Promise.allSettled([proc.stdout.cancel(), proc.stderr.cancel()]);
    return { kind: "no-answer", detail: `could not be read: ${errorMessage(cause)}`, stderr: "" };
  }

  // Redact first, truncate second. The other order can cut a secret in half and
  // leave a fragment no redaction pattern can recognise.
  const stderr = redactSecrets(run.stderr).slice(0, AUTH_HELPER_STDERR_MAX_BYTES);

  if (run.trip === "cap") {
    return {
      kind: "stdout-over-cap",
      detail: `wrote more than ${AUTH_HELPER_STDOUT_MAX_BYTES} bytes to stdout`,
      stderr,
    };
  }
  if (run.trip === "timeout") {
    return { kind: "timed-out", detail: `did not answer within ${timeoutMs}ms`, stderr };
  }
  if (run.exitCode === null) {
    return { kind: "no-answer", detail: "was killed before it could answer", stderr };
  }
  return { kind: "exited", exitCode: run.exitCode, stdout: run.stdout.text, stderr };
}
