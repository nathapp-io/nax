/**
 * Terminal lifecycle for one spawned quality command.
 *
 * `src/verification/executor.ts` already races its timeout signal against the
 * child's exit and bounds the post-kill wait; the quality runner awaited
 * `proc.exited` directly, so a detector stop on a child whose exit never arrives
 * left the invocation pending forever. This module is that shape, extracted so
 * `runner.ts` stays inside the file-size limit:
 *
 *  - one terminal latch between the four events that can end an invocation —
 *    leader exit, wall deadline, repeated output and silence;
 *  - bounded settlement after a stop (grace period, group probe, SIGKILL);
 *  - the notices the stopped result exposes.
 *
 * Every timer comes from the caller's injected deps, so tests drive it on a
 * virtual clock. This module imports types only, so it adds no runtime edge to
 * the runner it serves.
 */

import type { GateStopReason } from "../utils/gate-stall";

/** How much of a stopped agent-tool command's output is kept: the tail, so the agent can see where it stalled. */
export const TIMEOUT_OUTPUT_TAIL_CHARS = 4_000;

/** The timers and process-group seams this module drives; the runner passes its `_deps`. */
export interface CommandLifecycleDeps {
  killProcessGroup(
    pid: number,
    signal: NodeJS.Signals | number,
    opts?: { readonly singleProcessFallback?: boolean },
  ): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What ends one invocation. The first event the terminal latch records wins. */
export type TerminalEvent =
  | { readonly kind: "exit"; readonly exitCode: number }
  | { readonly kind: "deadline" }
  | { readonly kind: "stalled"; readonly reason: GateStopReason }
  | { readonly kind: "error"; readonly error: unknown };

export interface TerminalLatch {
  readonly terminal: Promise<TerminalEvent>;
  /** Record `event`, unless the invocation has already settled. */
  settle(event: TerminalEvent): void;
}

/**
 * One latch arbitrates the four things that can end an invocation: leader exit,
 * wall deadline, repeated output and silence. Later events are inert, so a
 * detector stop cannot be turned into a pass by a late exit 0, and a second stop
 * signal cannot start a second termination sequence.
 */
export function createTerminalLatch(): TerminalLatch {
  let settled: TerminalEvent | undefined;
  let notify: (event: TerminalEvent) => void = () => {};
  const terminal = new Promise<TerminalEvent>((resolve) => {
    notify = resolve;
  });
  return {
    terminal,
    settle(event) {
      if (settled !== undefined) return;
      settled = event;
      notify(event);
    },
  };
}

/**
 * Await `exited`, or report false once `ms` elapses. A child whose exit promise
 * never settles must not hold the invocation open past the grace period.
 */
export async function exitedWithin(deps: CommandLifecycleDeps, exited: Promise<number>, ms: number): Promise<boolean> {
  let handle: unknown;
  const deadline = new Promise<boolean>((resolve) => {
    handle = deps.setTimeout(() => resolve(false), ms);
  });
  // A rejected exit is not stall evidence, but it does mean the leader is gone.
  const leaderExited = await Promise.race([exited.then(() => true).catch(() => true), deadline]);
  deps.clearTimeout(handle);
  return leaderExited;
}

/**
 * SIGTERM the detached group, wait out a bounded grace period, then SIGKILL
 * whatever survives — the leader's exit does not end the group, and its bare pid
 * may already belong to someone else once it is gone.
 */
export async function stopProcessGroup(
  deps: CommandLifecycleDeps,
  options: {
    pid: number;
    gracePeriodMs: number;
    exited: Promise<number>;
    hasLeaderExited: () => boolean;
  },
): Promise<void> {
  const { pid, gracePeriodMs } = options;
  let leaderExited = options.hasLeaderExited();

  // The bare-pid fallback is only safe while the leader is still ours. Once its
  // exit has been observed its pid may already belong to an unrelated process,
  // and an ESRCH on the group would then signal that stranger — so the SIGTERM
  // carries the same restriction the SIGKILL and the group probe already do.
  deps.killProcessGroup(pid, "SIGTERM", { singleProcessFallback: !leaderExited });

  // setTimeout, not Bun.sleep: the grace timer must be cancellable, and it never
  // outlives this function — cleared below for an empty group, awaited otherwise.
  let sigkillTimer: unknown;
  const sigkillSent = new Promise<void>((resolve) => {
    sigkillTimer = deps.setTimeout(() => {
      deps.killProcessGroup(pid, "SIGKILL", { singleProcessFallback: !leaderExited });
      resolve();
    }, gracePeriodMs);
  });

  if (!leaderExited) leaderExited = await exitedWithin(deps, options.exited, gracePeriodMs);

  // Signal 0 probes whether the group still has a member without delivering
  // anything. An empty group has nothing left to kill; otherwise wait out the
  // rest of the grace period for the SIGKILL.
  if (leaderExited && !deps.killProcessGroup(pid, 0, { singleProcessFallback: false })) {
    deps.clearTimeout(sigkillTimer);
  } else {
    await sigkillSent;
  }
  // Cleared even once fired: every armed timer reaches clearTimeout (a no-op on a fired one).
  deps.clearTimeout(sigkillTimer);
}

/**
 * The notice, followed by the tail of `partial` (stdout, then stderr) cut at a
 * line boundary so no truncated path reaches the reader.
 */
export function noticeWithTail(notice: string, partial: string): string {
  const cut = partial.slice(-TIMEOUT_OUTPUT_TAIL_CHARS);
  const firstBreak = cut.indexOf("\n");
  const whole = partial.length > TIMEOUT_OUTPUT_TAIL_CHARS && firstBreak >= 0 ? cut.slice(firstBreak + 1) : cut;
  const tail = whole.trim();
  return tail === "" ? notice : `${notice}; last output before the kill:\n${tail}`;
}

export function timedOutOutput(commandName: string, timeoutMs: number, partial: string): string {
  return noticeWithTail(`[nax] ${commandName} timed out after ${timeoutMs / 1000}s`, partial);
}

/**
 * Name the detector evidence — the stream and threshold, or the silence setting.
 * It never carries the repeated line itself, nor any raw output.
 */
export function stopEvidence(reason: GateStopReason): string {
  return reason.kind === "repeated-output"
    ? `repeated-output on ${reason.stream} (line repeated ${reason.count} times, threshold ${reason.threshold})`
    : `silence (no output for ${reason.silenceTimeoutSeconds}s)`;
}

/**
 * A stalled run's output: the diagnostic notice, then — for the agent's own tool
 * only — the same bounded tail a wall timeout exposes. A harness run keeps the
 * notice alone, because its findings parsers would read a partial run as a
 * complete one.
 */
export function stoppedOutput(options: {
  commandName: string;
  reason: GateStopReason;
  partial: string;
  origin: "harness" | "agent-tool";
}): string {
  const notice = `[nax] ${options.commandName} stopped early: ${stopEvidence(options.reason)}`;
  return noticeWithTail(notice, options.origin === "agent-tool" ? options.partial : "");
}

/** The detector evidence as log fields — never the repeated line or raw output. */
export function stopLogFields(reason: GateStopReason): Record<string, string | number> {
  return reason.kind === "repeated-output"
    ? { stopKind: reason.kind, stream: reason.stream, count: reason.count, threshold: reason.threshold }
    : { stopKind: reason.kind, silenceTimeoutSeconds: reason.silenceTimeoutSeconds };
}
