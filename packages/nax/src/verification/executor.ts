/**
 * Test Execution Core
 *
 * Unified test execution logic with timeout handling and process cleanup.
 * Extracted from execution/verification.ts to eliminate duplication.
 */

import { resolve } from "node:path";
import { killProcessGroup, withAgentOutputEnv } from "@nathapp/nax-agent/internal";
import { spawn } from "@/utils/bun-deps";
import { assertTrusted } from "../trust";
import {
  createGateStallMonitor,
  type GateStallMonitor,
  type GateStallPolicy,
  type GateStopReason,
  resolveStallDetection,
} from "../utils/gate-stall";
import type { TestExecutionResult } from "./types";

/** Injectable deps for testability — mock _executorDeps.spawn instead of global Bun.spawn */
export const _executorDeps = {
  spawn,
  killProcessGroup,
  createGateStallMonitor,
  setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)) as (
    handle: unknown,
  ) => void,
};

/**
 * Defaults for the kill lane. Milliseconds, and only defaults: a caller passes
 * `gracePeriodMs` / `drainTimeoutMs` when it needs something else.
 */
const DEFAULT_GRACE_PERIOD_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Race an already-in-progress Promise against a deadline.
 *
 * Used to apply a hard cap to stream drain operations after a process is killed.
 * Uses setTimeout (not Bun.sleep) so the timer can be cleared once the race settles
 * — prevents timer leaks per rule 07.
 */
export const DRAIN_TIMEOUT = Symbol("drain-timeout");
export function raceWithDeadline<T>(p: Promise<T>, deadlineMs: number): Promise<T | typeof DRAIN_TIMEOUT> {
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
  const timeoutP = new Promise<typeof DRAIN_TIMEOUT>((r) => {
    timer.id = setTimeout(() => r(DRAIN_TIMEOUT), deadlineMs);
  });
  return Promise.race([p, timeoutP]).finally(() => clearTimeout(timer.id));
}

/**
 * Env vars that tell an agent-aware test runner to emit failures-only output.
 * `bun test` honours all three (https://bun.com/docs/test): failures keep their
 * full code frame, diff and stack, and the summary line is preserved — only the
 * per-test pass/skip/todo roll call is dropped.
 *
 * Re-exported from src/utils/agent-output-env.ts so the quality runner
 * (`src/quality/runner.ts:16`) keeps importing it from `@/verification`
 * unchanged. The marker list is the SSOT in the utils module — defining it
 * here would let a copy drift the moment one of them is edited, and the spawn
 * sites would silently stop agreeing on what counts as an inherited marker.
 */
export { AGENT_OUTPUT_MARKERS, withAgentOutputEnv } from "@nathapp/nax-agent/internal";

/**
 * Nothing is stripped unless the caller asks. This used to default to
 * AGENT_OUTPUT_MARKERS in order to "force standard output mode", which had it
 * exactly backwards: the roll call it restored is the one output nax never
 * reads, and it cost 12x on a single-file run and 241x on a directory
 * (measured, bun 1.4.0). Secret stripping is configured, not defaulted here —
 * see `quality.stripEnvVars`.
 */
const DEFAULT_STRIP_ENV_VARS: readonly string[] = [];

/**
 * Normalize environment variables for a verification subprocess.
 *
 * Strips what the caller asked for, then opts the child into agent-friendly
 * output. `AGENT=1` is only added when the caller carries no marker of its own
 * — so an inherited CLAUDECODE/REPL_ID is left to speak for itself, and an
 * explicit strip of AGENT is not silently undone.
 */
export function normalizeEnvironment(
  env: Record<string, string | undefined>,
  stripVars?: string[],
): Record<string, string | undefined> {
  const normalized = { ...env };
  const varsToStrip = stripVars ?? DEFAULT_STRIP_ENV_VARS;

  for (const varName of varsToStrip) {
    delete normalized[varName];
  }

  return withAgentOutputEnv(normalized, varsToStrip);
}

/**
 * Execute test command with hard timeout and process cleanup.
 *
 * Prevents zombie processes by sending SIGTERM, waiting for grace period,
 * then SIGKILL to entire process group.
 *
 * @design Shell trust boundary: `command` is passed verbatim to `/bin/sh -c`
 * because test commands legitimately need shell features (pipes, redirects,
 * env substitution). The command originates from `config.quality.commands.test`
 * in `.nax/config.json`, which is a **trusted** file — equivalent in trust to a
 * Makefile or shell script. Users are responsible for its contents. Do not pass
 * user-supplied or agent-generated strings here without explicit validation.
 */
export async function executeWithTimeout(
  command: string,
  timeoutSeconds: number,
  env?: Record<string, string | undefined>,
  options?: {
    shell?: string;
    gracePeriodMs?: number;
    drainTimeoutMs?: number;
    cwd?: string;
    /** Opt this invocation into stall detection. Absent means no detector at all. */
    stallDetection?: Partial<GateStallPolicy>;
  },
): Promise<TestExecutionResult> {
  // US-006: the test command comes from config and runs unsandboxed — refuse
  // before spawning unless a trust decision covers the cwd. resolve(".") is
  // Bun.spawn's own default cwd, so this is the directory that would host the
  // process either way. It also precedes the detector: an untrusted cwd must
  // not arm one.
  await assertTrusted(options?.cwd ?? resolve("."), "test-command");
  const shell = options?.shell ?? "/bin/sh";
  const gracePeriodMs = options?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const drainTimeoutMs = options?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  // One latch arbitrates the four things that can end this invocation: leader
  // exit, wall deadline, repeated output and silence. The first observed while
  // the process is live wins; everything that arrives later is inert.
  const latch = createTerminalLatch();
  // Observed separately from the latch: an exit that arrives after a detector
  // stop changes no outcome, but it does mean the leader's pid is no longer
  // ours, which the cleanup lane must respect.
  let leaderExited = false;

  // nax-git-env-allow: not git: test command via /bin/sh
  const proc = _executorDeps.spawn([shell, "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: env || normalizeEnvironment(process.env as Record<string, string | undefined>),
    cwd: options?.cwd,
    // Bun.spawn does not setpgid children into their own group by default, so
    // killProcessGroup(-pid) below would target a group the shell isn't actually
    // the leader of (ESRCH -> falls back to killing only the /bin/sh wrapper,
    // leaking the real test-runner grandchild). `detached` makes this process a
    // session/group leader via setsid(), so its own pid IS the real pgid.
    detached: true,
  });

  // Floating by design (mirrors src/quality/runner.ts): a rejected proc.exited
  // must not surface as an unhandled rejection, and it is not a stall — the wall
  // deadline still bounds the invocation.
  proc.exited
    .then((exitCode) => {
      leaderExited = true;
      latch.settle({ kind: "exit", exitCode });
    })
    .catch(() => {});

  // The monitor arms a silence deadline the moment it is created, so it comes
  // AFTER spawn (a spawn failure must not leave a timer or a callback behind)
  // and it is disposed if stream setup throws before the latch can settle it.
  let monitor: GateStallMonitor | undefined;
  let collectors: OutputCollectors;
  try {
    monitor = startStallMonitor(options?.stallDetection, latch);
    // Rule 07: both streams are read concurrently with the leader's exit (a
    // sequential read deadlocks on >64KB), and every chunk reaches the detector
    // as it arrives — so a repeated line stops a live process long before its
    // wall deadline. The collector decodes independently of the detector: the
    // captured text is never rewritten by detection.
    collectors = openCollectors(proc, monitor);
  } catch (error) {
    monitor?.dispose();
    throw error;
  }

  const wallTimer = _executorDeps.setTimeout(() => latch.settle({ kind: "deadline" }), timeoutSeconds * 1000);

  const terminal = await latch.terminal;
  // Settlement disarms everything this invocation armed — the wall deadline, the
  // silence deadline and every detector callback — so nothing late can change
  // the outcome and no timer outlives the call.
  _executorDeps.clearTimeout(wallTimer);
  monitor?.dispose();

  if (terminal.kind === "exit") {
    const drained = await drainOutputs(collectors, drainTimeoutMs);
    return {
      success: terminal.exitCode === 0,
      timeout: false,
      exitCode: terminal.exitCode,
      output: `${drained.stdout}\n${drained.stderr}`,
      countsTowardEscalation: true,
    };
  }

  // A detector stop takes the SAME lane as a wall deadline, and each invocation
  // enters it at most once: the latch has already settled, so no later stop or
  // deadline callback can start a second termination sequence.
  await terminateProcessGroup({
    pid: proc.pid,
    gracePeriodMs,
    exited: proc.exited,
    hasLeaderExited: () => leaderExited,
  });
  const drained = await drainOutputs(collectors, drainTimeoutMs);
  return stoppedResult({ terminal, pid: proc.pid, timeoutSeconds, drained });
}

/** What ends an invocation. The first event the latch records wins. */
type TerminalEvent =
  | { readonly kind: "exit"; readonly exitCode: number }
  | { readonly kind: "deadline" }
  | { readonly kind: "stalled"; readonly reason: GateStopReason };

interface TerminalLatch {
  readonly terminal: Promise<TerminalEvent>;
  /** Record `event`, unless the invocation has already settled. */
  settle(event: TerminalEvent): void;
}

function createTerminalLatch(): TerminalLatch {
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
 * Start the detector, or nothing at all when the caller did not opt in — no
 * monitor means no detector callback can stop the run. A stop enters the latch
 * exactly like a wall deadline, which is what puts both on one cleanup lane.
 */
function startStallMonitor(
  stallDetection: Partial<GateStallPolicy> | undefined,
  latch: TerminalLatch,
): GateStallMonitor | undefined {
  if (stallDetection === undefined) return undefined;
  return _executorDeps.createGateStallMonitor({
    policy: resolveStallDetection(stallDetection),
    onStop: (reason) => latch.settle({ kind: "stalled", reason }),
    setTimeout: (fn, ms) => _executorDeps.setTimeout(fn, ms),
    clearTimeout: (handle) => _executorDeps.clearTimeout(handle),
  });
}

interface StreamCollector {
  /** Resolves once the reader stopped reading — on end, on error, or on cancel. */
  readonly done: Promise<void>;
  text(): string;
  cancel(): Promise<void>;
  isDone(): boolean;
}

interface OutputCollectors {
  readonly stdout: StreamCollector;
  readonly stderr: StreamCollector;
}

function openCollectors(
  proc: { stdout: unknown; stderr: unknown },
  monitor: GateStallMonitor | undefined,
): OutputCollectors {
  return {
    stdout: collectStream(
      proc.stdout as ReadableStream<Uint8Array>,
      (chunk) => monitor?.observe("stdout", chunk),
      () => monitor?.end("stdout"),
    ),
    stderr: collectStream(
      proc.stderr as ReadableStream<Uint8Array>,
      (chunk) => monitor?.observe("stderr", chunk),
      () => monitor?.end("stderr"),
    ),
  };
}

/**
 * Read one stream to its end, showing each chunk to the detector as it arrives
 * and decoding it separately for the captured text.
 *
 * A stream error is not itself repetition or silence: the bytes read before the
 * failure are kept, and `end` is only fed on a clean end of stream — a failed
 * read leaves the existing exit/error policy untouched.
 */
function collectStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  onEnd: () => void,
): StreamCollector {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let finished = false;
  const done = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        onChunk(next.value);
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      onEnd();
    } catch {
      // A stream that fails still keeps every chunk read before the failure.
    } finally {
      finished = true;
    }
  })();
  return { done, text: () => text, cancel: () => reader.cancel(), isDone: () => finished };
}

/**
 * Drain one already-in-progress read, bounded by `deadlineMs`.
 *
 * Bun bug: piped streams may not close after a kill — the deadline is what stops
 * this from hanging. Cancellation is best-effort and never awaited, so it cannot
 * extend the deadline; whatever was collected still comes back.
 */
async function drainStream(collector: StreamCollector, deadlineMs: number): Promise<string> {
  let timer: unknown;
  const deadline = new Promise<boolean>((resolve) => {
    timer = _executorDeps.setTimeout(() => resolve(true), deadlineMs);
  });
  const expired = await Promise.race([collector.done.then(() => false), deadline]);
  _executorDeps.clearTimeout(timer);
  if (expired && !collector.isDone()) void collector.cancel().catch(() => {});
  return collector.text();
}

/** Drain stdout and stderr together, so neither blocks the other's reader. */
async function drainOutputs(
  collectors: OutputCollectors,
  deadlineMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const [stdout, stderr] = await Promise.all([
    drainStream(collectors.stdout, deadlineMs),
    drainStream(collectors.stderr, deadlineMs),
  ]);
  return { stdout, stderr };
}

/**
 * SIGTERM the detached process group, wait out a bounded grace period, then
 * SIGKILL whatever survives — the leader's exit does not end the group, and its
 * bare pid may already belong to someone else once it is gone.
 */
async function terminateProcessGroup(options: {
  readonly pid: number;
  readonly gracePeriodMs: number;
  readonly exited: Promise<number>;
  /** Whether the caller has already observed the leader's exit. */
  readonly hasLeaderExited: () => boolean;
}): Promise<void> {
  const { pid, gracePeriodMs } = options;
  let leaderExited = options.hasLeaderExited();

  // Send SIGTERM to process group to kill children too. The group kill may hit
  // ESRCH when the group is already gone; falling back to the bare pid is only
  // safe while the leader is still ours, because its pid may have been reused by
  // an unrelated process once it has exited.
  _executorDeps.killProcessGroup(pid, "SIGTERM", { singleProcessFallback: !leaderExited });

  // setTimeout (not Bun.sleep) because the timer must be cancellable: it is
  // cleared below when the group is already empty, and otherwise awaited, so it
  // never outlives this call.
  let sigkillTimer: unknown;
  const sigkillSent = new Promise<void>((resolve) => {
    sigkillTimer = _executorDeps.setTimeout(() => {
      _executorDeps.killProcessGroup(pid, "SIGKILL", { singleProcessFallback: !leaderExited });
      resolve();
    }, gracePeriodMs);
  });

  // Wait for graceful shutdown, but bail early if the process already exited.
  // Bun.sleep is not cancellable; use setTimeout via raceWithDeadline so the
  // grace timer is cleared as soon as the process exits — an armed one keeps
  // Bun's event loop alive for the full grace period after this call returned.
  await raceWithDeadline(
    options.exited
      .then(() => {
        leaderExited = true;
      })
      .catch(() => {}),
    gracePeriodMs,
  );

  // Signal 0 probes whether the group still has a member without delivering
  // anything. An empty group has nothing left to kill; otherwise wait out the
  // rest of the grace period for the SIGKILL (a Linux zombie still counts as a
  // member until reaped, so this can wait the full grace period there).
  if (leaderExited && !_executorDeps.killProcessGroup(pid, 0, { singleProcessFallback: false })) {
    _executorDeps.clearTimeout(sigkillTimer);
  } else {
    await sigkillSent;
  }
  // Cleared even once fired: every armed timer reaches clearTimeout (a no-op on a fired one).
  _executorDeps.clearTimeout(sigkillTimer);
}

/**
 * The timeout-lane result. A detector stop carries its structured reason and a
 * message naming what actually happened, so it never claims the wall deadline
 * elapsed; a wall deadline carries no `stopReason` at all.
 */
function stoppedResult(options: {
  readonly terminal: TerminalEvent;
  readonly pid: number;
  readonly timeoutSeconds: number;
  readonly drained: { stdout: string; stderr: string };
}): TestExecutionResult {
  const output = [options.drained.stdout, options.drained.stderr].filter(Boolean).join("\n") || undefined;
  const base = {
    success: false,
    timeout: true,
    killed: true,
    childProcessesKilled: true,
    output,
    countsTowardEscalation: false, // Timeout is environmental, not code failure
  };
  if (options.terminal.kind !== "stalled") {
    return {
      ...base,
      error: `EXECUTION_TIMEOUT: Verification process exceeded ${options.timeoutSeconds}s. Process group (PID ${options.pid}) killed.`,
    };
  }
  const reason = options.terminal.reason;
  return { ...base, error: stallErrorMessage(reason, options.pid), stopReason: reason };
}

/** Name the detector evidence — the stream and threshold, or the silence setting. */
function stallErrorMessage(reason: GateStopReason, pid: number): string {
  const evidence =
    reason.kind === "repeated-output"
      ? `${reason.stream} repeated the same line ${reason.count} times (threshold ${reason.threshold})`
      : `no output for ${reason.silenceTimeoutSeconds}s (silenceTimeoutSeconds: ${reason.silenceTimeoutSeconds})`;
  return `EXECUTION_STALLED: Verification process made no progress: ${evidence}. Process group (PID ${pid}) killed.`;
}

/**
 * Check if a test command already includes --detectOpenHandles.
 */
function detectOpenHandlesFlag(command: string): boolean {
  return command.includes("--detectOpenHandles");
}

/**
 * Append --detectOpenHandles to a test command for diagnostic retry.
 */
export function appendOpenHandlesFlag(command: string): string {
  if (detectOpenHandlesFlag(command)) return command;
  return appendFlag(command, "--detectOpenHandles");
}

/**
 * Check if a test command already includes --forceExit.
 */
function forceExitFlag(command: string): boolean {
  return command.includes("--forceExit");
}

/**
 * Append --forceExit to a test command to force process exit after tests.
 */
export function appendForceExitFlag(command: string): string {
  if (forceExitFlag(command)) return command;
  return appendFlag(command, "--forceExit");
}

/**
 * Append a flag to a command, inserting before any pipe/redirect.
 *
 * Quote-aware: a `|`/`>` inside a single- or double-quoted argument is not a
 * split point. A `>` immediately preceded by a fd number (e.g. `2>&1`) is
 * treated as part of the redirect token, so the flag is inserted before the
 * whole `N>` sequence rather than in the middle of it.
 */
function appendFlag(command: string, flag: string): string {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "|" || char === ">") {
      let splitIndex = i;
      if (char === ">") {
        // A digit run before `>` is only an fd number (e.g. `2>&1`) when it is
        // a standalone token — preceded by whitespace, start-of-string, or a
        // shell operator. Digits glued onto a longer word (e.g. `file123>out`)
        // are part of that word, not an fd: real shells treat `file123>out`
        // as the single argument "file123" followed by a plain redirect, not
        // as fd 123.
        let digitStart = splitIndex;
        while (digitStart > 0 && /[0-9]/.test(command[digitStart - 1] ?? "")) digitStart--;
        const charBeforeDigits = command[digitStart - 1];
        const isStandaloneFdToken =
          digitStart < splitIndex && (digitStart === 0 || /[\s|;&]/.test(charBeforeDigits ?? ""));
        if (isStandaloneFdToken) splitIndex = digitStart;
      }
      return `${command.slice(0, splitIndex).trimEnd()} ${flag} ${command.slice(splitIndex)}`;
    }
  }
  return `${command} ${flag}`;
}

/**
 * Build the final test command based on quality config and retry state.
 */
export function buildTestCommand(
  baseCommand: string,
  options: {
    forceExit?: boolean;
    detectOpenHandles?: boolean;
    detectOpenHandlesRetries?: number;
    timeoutRetryCount?: number;
  },
): string {
  let command = baseCommand;

  const { forceExit = false, detectOpenHandles = true, detectOpenHandlesRetries = 1, timeoutRetryCount = 0 } = options;

  // If we've exhausted detectOpenHandles retries, force exit as last resort
  const exhaustedDiagnosticRetries = timeoutRetryCount > detectOpenHandlesRetries;

  // Apply --forceExit if configured or if diagnostic retries exhausted
  if (forceExit || exhaustedDiagnosticRetries) {
    command = appendForceExitFlag(command);
  }

  // Apply --detectOpenHandles on timeout retries (within cap)
  if (detectOpenHandles && timeoutRetryCount > 0 && timeoutRetryCount <= detectOpenHandlesRetries) {
    command = appendOpenHandlesFlag(command);
  }

  return command;
}
