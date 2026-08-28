/**
 * Shared spawn/teardown helpers for spawn-client.ts — split out to keep that
 * file under the file-size ratchet.
 *
 * PERF-1: bounds trackedSpawn's proc.exited await with a hard deadline so a
 * wedged acpx subprocess (sessions close/stop/cancel) cannot hang the caller
 * (e.g. run teardown) indefinitely.
 *
 * ORPHAN-1: kills the acpx process *group*, not just the single tracked PID,
 * escalating from SIGTERM to SIGKILL after a short grace period. Mirrors the
 * verification/executor.ts hard-kill pattern.
 */

import { getSafeLogger } from "@/logger";
import { cancellableDelay, type SpawnOptions, type SpawnResult } from "@/utils/bun-deps";
import { isProcessAlive } from "@/utils/process-alive";
import { killProcessGroup } from "@/utils/process-kill";

export interface TrackedSpawnDeps {
  spawn: (cmd: string[], opts: SpawnOptions) => SpawnResult;
  trackedSpawnDeadlineMs: number;
  /** SIGTERM->SIGKILL escalation grace period for the timeout/abort kill path. */
  killTreeGraceMs: number;
  /** Bounded wait for stream drain after proc.exited (MEM-19) — shared with prompt(). */
  streamDrainTimeoutMs: number;
}

/** Cancel handle returned by killProcessTree — lets a later kill-tree call for
 * the same pid cancel a still-armed escalation timer instead of arming a
 * duplicate (BUG-6). */
export interface KillTreeHandle {
  cancel(): void;
}

/**
 * Bounded drain timer for a stream read (MEM-19). Races the caller's
 * `.text()`/parse promise; the timer side resolves to `""` so a pipe that
 * never EOFs (grandchild inherited the fd, Bun bug) cannot hang the caller.
 * The timer is always cleared when the race settles, so no uncancellable
 * timer survives across calls.
 */
export function makeStreamDrain(ms: number): { promise: Promise<string>; cancel: () => void } {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<string>((resolve) => {
    id = setTimeout(() => resolve(""), ms);
  });
  // Promise executor runs synchronously — id is set before return.
  return { promise, cancel: () => clearTimeout(id) };
}

// BUG-6: one escalation timer per pid. A second killProcessTree() call for the
// same pid (e.g. cancelActivePrompt() immediately followed by close()) cancels
// the first timer instead of arming an independent duplicate.
const activeKillTimers = new Map<number, KillTreeHandle>();

/**
 * Best-effort liveness probe — signal 0 sends no actual signal, only checks
 * whether the OS still has a process at `pid`. Used before escalating to
 * SIGKILL so a reused/unrelated pid (the original process already reaped)
 * isn't signalled — mirrors verification/executor.ts's exitedDuringGrace guard.
 */

/**
 * Terminate a process tree by group PID: SIGTERM immediately, SIGKILL
 * escalation after `graceMs` if the group is still alive. Requires the
 * process to have been spawned with `detached: true` so its own PID is a
 * real process-group leader (see spawn-client.ts prompt() spawn).
 *
 * BUG-6: checks liveness (via `isProcessAlive`, or by racing the optional
 * `exited` promise against the grace period when the caller has one) before
 * sending SIGKILL — an unconditional escalation risks hitting a PID the OS
 * has since reused for an unrelated process. Returns a cancel handle so a
 * second kill-tree call for the same pid can cancel/skip the first timer.
 */
export function killProcessTree(pid: number, graceMs: number, exited?: Promise<unknown>): KillTreeHandle {
  activeKillTimers.get(pid)?.cancel();
  activeKillTimers.delete(pid);

  try {
    killProcessGroup(pid, "SIGTERM");
    getSafeLogger()?.debug("acp-adapter", `Sent SIGTERM to process group ${pid}`);
  } catch {
    // Process may have already exited
  }

  let settled = false;
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
  const gracePromise = new Promise<"grace">((resolve) => {
    timer.id = setTimeout(() => resolve("grace"), graceMs);
    if (timer.id.unref) timer.id.unref();
  });
  const exitedPromise = exited?.then(
    () => "exited" as const,
    () => "exited" as const,
  );
  const raced = exitedPromise !== undefined ? Promise.race([gracePromise, exitedPromise]) : gracePromise;

  void raced.then((outcome) => {
    // Rule 07: always clear the grace timer once the race settles, regardless
    // of which side won or whether this call was cancelled — an armed-but-
    // uncleared setTimeout holds the event loop open even when unref'd from
    // some runtimes' perspective, and is flagged by leak-detection tooling.
    clearTimeout(timer.id);
    if (settled) return; // cancelled
    settled = true;
    activeKillTimers.delete(pid);
    if (outcome === "exited") return;
    // Grace elapsed without the process signalling exit — re-check liveness
    // directly (covers callers with no `exited` promise) before escalating.
    if (!isProcessAlive(pid)) return;
    try {
      killProcessGroup(pid, "SIGKILL");
    } catch {
      // Process may have already exited
    }
  });

  const handle: KillTreeHandle = {
    cancel: () => {
      settled = true;
      clearTimeout(timer.id);
      activeKillTimers.delete(pid);
    },
  };
  activeKillTimers.set(pid, handle);
  return handle;
}

/**
 * Spawn a command and drain stdout/stderr concurrently with a bounded wait on
 * `proc.exited`. On timeout (or external abort via `signal`), kills the
 * process tree and best-effort cancels stdout/stderr before returning
 * `exitCode: -1` — a wedged/aborted subprocess is not left to survive its own
 * caller giving up on it (PERF-1/BUG-3/BUG-4). `onPidExited` still fires
 * whenever the process actually exits, even after this function has already
 * returned on timeout, so the caller's PID bookkeeping stays accurate.
 */
export async function runTrackedSpawn(
  deps: TrackedSpawnDeps,
  cmd: string[],
  opts: SpawnOptions | undefined,
  onPidSpawned: ((pid: number) => void) | undefined,
  onPidExited: ((pid: number) => void) | undefined,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = deps.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...opts });
  const pid = proc.pid;
  onPidSpawned?.(pid);

  const exitedNotified = proc.exited
    .catch(() => -1)
    .finally(() => {
      try {
        onPidExited?.(pid);
      } catch {
        // unregister is best-effort — never surface from trackedSpawn
      }
    });

  // PERF-1: race the deadline through a locally-owned AbortController instead
  // of relying on cancellableDelay's own cancellation alone. Composing the
  // caller's signal into this controller means we can explicitly abort it (and
  // therefore clear cancellableDelay's internal setTimeout, and detach any
  // abort listener it registered on `signal`) in the `finally` below —
  // regardless of which side of the race won. Without this, cancellableDelay's
  // timer stays armed for the full deadline even after proc.exited already won.
  const deadlineController = new AbortController();
  const forwardAbort = () => deadlineController.abort(signal?.reason);
  if (signal?.aborted) {
    deadlineController.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", forwardAbort, { once: true });
  }

  const deadline = cancellableDelay(deps.trackedSpawnDeadlineMs, deadlineController.signal).catch(() => {});

  try {
    const raced = await Promise.race([
      exitedNotified.then((code) => ({ timedOut: false as const, code })),
      deadline.then(() => ({ timedOut: true as const, code: -1 })),
    ]);

    if (raced.timedOut) {
      // BUG-4: distinguish a genuine wedged-process timeout from the caller's
      // own signal having already fired (e.g. run-wide shutdown) — both take
      // the same kill action, but must be logged/reported differently so
      // "acpx is stuck" isn't conflated with "we're tearing down".
      const reason = signal?.aborted ? "aborted" : "deadline exceeded";
      getSafeLogger()?.warn("acp-adapter", `trackedSpawn ${reason} — killing process tree for PID ${pid}`, {
        pid,
        deadlineMs: deps.trackedSpawnDeadlineMs,
        reason,
      });
      // BUG-3: kill the wedged/aborted process tree instead of abandoning it —
      // otherwise it survives past the caller giving up on waiting for it.
      killProcessTree(pid, deps.killTreeGraceMs, proc.exited);
      try {
        proc.stdout?.cancel?.();
      } catch {
        // best-effort — stream may already be closed/errored
      }
      try {
        proc.stderr?.cancel?.();
      } catch {
        // best-effort — stream may already be closed/errored
      }
      return { exitCode: -1, stdout: "", stderr: "" };
    }

    // MEM-19: the normal-exit drain has the same missing-EOF hazard as the
    // timeout path — a grandchild inheriting the pipe fd and outliving acpx
    // keeps the stream open forever, and the pre-fix `Response(...).text()`
    // awaited it with no bound (the PERF-1 deadline bounds `exited`, not the
    // drain). Race each stream against the shared drain timer, exactly like
    // prompt() does; the drain winning returns "" for that stream.
    const [stdout, stderr] = await Promise.all([
      drainStream(proc.stdout, deps.streamDrainTimeoutMs),
      drainStream(proc.stderr, deps.streamDrainTimeoutMs),
    ]);
    return { exitCode: raced.code, stdout, stderr };
  } finally {
    // PERF-1: always cancel the deadline timer and detach the abort listener,
    // regardless of which side of the race resolved.
    deadlineController.abort();
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * MEM-19: drain a process stream with a bounded wait. Returns the full text
 * when the stream EOFs promptly; returns "" (and cancels the reader so its
 * pending read settles — MEM-38 hygiene) when the drain timer wins.
 *
 * The reader is owned here rather than handed to a `Response` body: a locked
 * stream cannot be cancelled, so `reader.cancel()` on the drain-win path is
 * what actually releases the pending read (a `Response` body would keep it
 * parked for the process lifetime).
 */
async function drainStream(stream: ReadableStream<Uint8Array> | null, timeoutMs: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const readAll = async (): Promise<string> => {
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  };
  const drain = makeStreamDrain(timeoutMs);
  const winner = await Promise.race([
    readAll()
      .catch(() => "")
      .then((text) => ({ fromStream: true as const, text })),
    drain.promise.then(() => ({ fromStream: false as const, text: "" })),
  ]).finally(() => drain.cancel());
  if (!winner.fromStream) {
    reader.cancel().catch(() => {});
  }
  return winner.text;
}
