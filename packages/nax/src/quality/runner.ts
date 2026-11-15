/**
 * Quality Command Runner
 *
 * Shared utility for spawning quality check processes (lint, typecheck, build,
 * test) with a hard timeout, concurrent stdout/stderr draining,
 * and structured logging.
 *
 * All callers that previously spawned quality processes inline should use
 * runQualityCommand() instead. (#135)
 */

import {
  errorMessage,
  killProcessGroup,
  normalizeCommandSpec,
  type QualityCommandSpec,
} from "@nathapp/nax-agent/internal";
import { spawn } from "bun";
import { getSafeLogger } from "../logger";
import { assertTrusted } from "../trust";
import {
  createGateStallMonitor,
  type GateStallMonitor,
  type GateStallPolicy,
  type GateStopReason,
  resolveStallDetection,
} from "../utils/gate-stall";
import { withAgentOutputEnv } from "../verification/executor";
import { aggregateResults } from "./aggregate";
import { qualityLogsAreQuiet } from "./log-scope";
import {
  createTerminalLatch,
  stopLogFields,
  stopProcessGroup,
  stoppedOutput,
  type TerminalLatch,
  timedOutOutput,
} from "./runner-lifecycle";

/** Default timeout for quality commands — matches legacy REVIEW_CHECK_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Grace period between SIGTERM and SIGKILL on timeout. */
const SIGKILL_GRACE_PERIOD_MS = 5_000;
export const STREAM_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Colour-control defaults added to every spawned quality command and gate.
 *
 * ANSI colour codes made 223 of 501 `RunCommand` failures unreadable in one
 * project: the escapes cost the agent context and break output parsing for no
 * benefit — nothing downstream renders colour. `NO_COLOR` is the portable opt
 * out; `FORCE_COLOR=0` covers the tools that honour only the Node convention.
 * Neither overrides a value the caller or its environment already set — see
 * {@link withNoColorEnv}.
 */
const NO_COLOR_ENV: Readonly<Record<string, string>> = { NO_COLOR: "1", FORCE_COLOR: "0" };

/**
 * Add the no-color defaults to an env, without overriding anything the caller
 * (or its environment) already decided.
 *
 * Two "already decided" cases, both left as they are:
 * - a variable the base env already sets — an explicit empty value counts as
 *   set, so `NO_COLOR: ""` survives verbatim;
 * - a variable named in `strippedVars` — stripping it was deliberate, so the
 *   default must not resurrect it.
 *
 * The caller's `env` option is applied by {@link runSingleCommand} AFTER this,
 * so a per-call override still wins last.
 */
export function withNoColorEnv(
  env: Record<string, string | undefined>,
  strippedVars: readonly string[] = [],
): Record<string, string | undefined> {
  const result = { ...env };
  for (const [key, value] of Object.entries(NO_COLOR_ENV)) {
    if (strippedVars.includes(key)) continue;
    if (result[key] !== undefined) continue;
    result[key] = value;
  }
  return result;
}

/**
 * How much of a stopped agent-tool command's output is kept: the tail, so the
 * agent can see which step was still running (#2536). Harness runs keep only
 * the notice, because their findings parsers would read a partial run as a
 * complete one. Defined beside the notices that cut it.
 */
export { TIMEOUT_OUTPUT_TAIL_CHARS } from "./runner-lifecycle";

export interface QualityCommandOptions {
  /** Short name used in logs (e.g. "lint", "typecheck", "build"). */
  commandName: string;
  /**
   * The command to run. A string is one shell command. A list runs every
   * entry — even after one fails — and aggregates the results, so a
   * multi-step gate reports all its failures in one invocation (nax#1990).
   */
  command: QualityCommandSpec;
  /** Working directory for the spawned process. */
  workdir: string;
  /** Optional story ID for log correlation. */
  storyId?: string;
  /** Hard timeout in milliseconds. Defaults to 120 000 ms. */
  timeoutMs?: number;
  /** Optional environment overrides for the spawned process. */
  env?: Record<string, string | undefined>;
  /** Secret env var names to strip before spawning the shell command. */
  stripEnvVars?: string[];
  /**
   * Who invoked this run. Defaults to `"harness"`.
   *
   * `"agent-tool"` marks the agent's own iteration loop arriving through the
   * `RunCommand` coding tool (packages/nax-agent/src/tools/run-command.ts). Those records are
   * demoted to debug: they still reach the JSONL (the file sink writes every
   * level) but stay off the console, because a failing lint there is normal TDD
   * red rather than a harness fault — and because on the ACP transport the
   * identical loop runs inside the spawned agent process, where nax never sees
   * it at all. Leaving them at info made the two transports produce wildly
   * different logs for the same work: one observed native run emitted 289
   * quality pairs, 283 of them (98%) from this path.
   */
  origin?: "harness" | "agent-tool";
  /**
   * Opt this invocation into stall detection. Absent means no detector at all:
   * repetition and silence are never inferred for a caller that did not ask,
   * so an agent-tool iteration loop keeps its own behaviour.
   */
  stallDetection?: Partial<GateStallPolicy>;
}

export interface QualityCommandResult {
  commandName: string;
  command: string;
  success: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * Present only when a detector stopped this command. A wall timeout carries
   * no reason, and the property is absent rather than undefined on that path.
   */
  stopReason?: GateStopReason;
}

/**
 * Injectable dependencies — allows tests to swap out Bun.spawn without
 * mock.module() (BUG-035 pattern).
 *
 * @internal
 */
export const _qualityRunnerDeps = {
  spawn: spawn as typeof Bun.spawn,
  killProcessGroup,
  createGateStallMonitor,
  setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)) as (
    handle: unknown,
  ) => void,
};

interface StreamCollector {
  done: Promise<void>;
  text: () => string;
  cancel: () => Promise<void>;
}

/**
 * Read one stream to its end, showing each chunk to the detector as it arrives
 * and decoding it separately for the captured text, so detection never rewrites
 * what the caller sees.
 *
 * A stream error is not repetition or silence: the bytes read before the failure
 * are kept and `onEnd` is not fed, which leaves the existing exit/error policy
 * untouched.
 */
function collectStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  onEnd: () => void,
): StreamCollector {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        onChunk(next.value);
        output += decoder.decode(next.value, { stream: true });
      }
      output += decoder.decode();
      onEnd();
    } catch {
      // A stream that fails still returns every chunk read before the failure.
    }
  })();
  return { done, text: () => output, cancel: () => reader.cancel() };
}

/**
 * Start both readers before the leader is awaited — a sequential read deadlocks
 * on output larger than the OS pipe buffer (~64KB).
 */
function openCollectors(
  proc: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> },
  monitor: GateStallMonitor | undefined,
): { stdout: StreamCollector; stderr: StreamCollector } {
  return {
    stdout: collectStream(
      proc.stdout,
      (chunk) => monitor?.observe("stdout", chunk),
      () => monitor?.end("stdout"),
    ),
    stderr: collectStream(
      proc.stderr,
      (chunk) => monitor?.observe("stderr", chunk),
      () => monitor?.end("stderr"),
    ),
  };
}

/**
 * Start the stall detector, or nothing at all when the caller did not opt in.
 * A stop enters the latch exactly like a wall deadline, which is what puts both
 * on the same cleanup lane.
 */
function startStallMonitor(
  stallDetection: Partial<GateStallPolicy> | undefined,
  latch: TerminalLatch,
): GateStallMonitor | undefined {
  if (stallDetection === undefined) return undefined;
  return _qualityRunnerDeps.createGateStallMonitor({
    policy: resolveStallDetection(stallDetection),
    onStop: (reason) => latch.settle({ kind: "stalled", reason }),
    setTimeout: (fn, ms) => _qualityRunnerDeps.setTimeout(fn, ms),
    clearTimeout: (handle) => _qualityRunnerDeps.clearTimeout(handle),
  });
}

async function drainStream(collector: StreamCollector): Promise<{ output: string; timedOut: boolean }> {
  let timeoutId: unknown;
  const deadline = new Promise<boolean>((resolve) => {
    timeoutId = _qualityRunnerDeps.setTimeout(() => resolve(true), STREAM_DRAIN_TIMEOUT_MS);
  });
  const timedOut = await Promise.race([collector.done.then(() => false), deadline]);
  if (timeoutId !== undefined) _qualityRunnerDeps.clearTimeout(timeoutId);
  if (timedOut) {
    // Cancellation is best-effort; it must not extend the drain deadline.
    void collector.cancel().catch(() => {});
  }
  return { output: collector.text(), timedOut };
}

async function drainOutputStreams(opts: {
  stdout: StreamCollector;
  stderr: StreamCollector;
  pid: number;
  timedOut: boolean;
}): Promise<[string, string]> {
  const [stdout, stderr] = await Promise.all([drainStream(opts.stdout), drainStream(opts.stderr)]);
  if (!opts.timedOut && (stdout.timedOut || stderr.timedOut)) {
    _qualityRunnerDeps.killProcessGroup(opts.pid, "SIGTERM", { singleProcessFallback: false });
  }
  return [stdout.output, stderr.output];
}

/**
 * Spawn a quality-check command, collect its output, and enforce a hard
 * timeout with SIGTERM → SIGKILL escalation.
 *
 * stdout and stderr are drained concurrently with proc.exited via Promise.all
 * to avoid deadlocking on output larger than the OS pipe buffer (~64 KB).
 */
async function runSingleCommand(
  opts: Omit<QualityCommandOptions, "command"> & { command: string },
): Promise<QualityCommandResult> {
  const {
    commandName,
    command,
    workdir,
    storyId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env,
    stripEnvVars,
    origin = "harness",
  } = opts;

  if (!command || command.trim() === "") {
    return {
      commandName,
      command,
      success: false,
      exitCode: -1,
      output: `[nax] ${commandName} skipped: empty command`,
      durationMs: 0,
      timedOut: false,
    };
  }

  const startTime = Date.now();
  const logger = getSafeLogger();
  // Console level follows the caller, not the outcome — see `origin` above.
  const level = origin === "agent-tool" || qualityLogsAreQuiet() ? "debug" : "info";

  logger?.[level]("quality", `Running ${commandName}`, { storyId, commandName, command, workdir });

  try {
    // Build the base env, stripping any configured secret vars before spawning.
    const baseEnv: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
    };
    for (const key of stripEnvVars ?? []) {
      delete baseEnv[key];
    }
    // Opt the child into agent-friendly output (failures + summary, no pass
    // roll call). Shared with verification/executor.ts so the two spawn sites
    // cannot drift; a caller that strips AGENT keeps it stripped.
    const agentEnv = withAgentOutputEnv(baseEnv, stripEnvVars ?? []);
    // …and out of ANSI colour: this spawn site backs every declared command the
    // agent calls through `RunCommand` plus every quality gate. Added AFTER the
    // agent-output env so the two helpers stay independent, and BEFORE the
    // caller's `env` overlay below so an explicit override still wins last.
    const noColorEnv = withNoColorEnv(agentEnv, stripEnvVars ?? []);

    // Execute via shell to preserve quoting semantics of configured commands.
    // Splitting on whitespace loses quoted args and escaped spaces.
    // nax-git-env-allow: not git: configured quality command via /bin/sh
    const proc = _qualityRunnerDeps.spawn({
      cmd: ["/bin/sh", "-c", command],
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...noColorEnv, ...(env ?? {}) },
      // Bun.spawn does not setpgid children into their own group by default, so
      // killProcessGroup(-pid) on timeout would target a group the shell isn't
      // actually the leader of (ESRCH -> falls back to killing only the /bin/sh
      // wrapper, leaking the real grandchild process). `detached` makes this
      // process a session/group leader via setsid(), so its own pid IS the real
      // pgid. Mirrors executeWithTimeout in verification/executor.ts.
      detached: true,
    });

    let leaderExited = false;

    // One latch arbitrates the four things that can end this invocation: the
    // leader's exit, the wall deadline, repeated output and silence. The first
    // event observed while the child is live wins; everything later is inert.
    const latch = createTerminalLatch();
    // The shell leader's exit says nothing about the rest of its group, so it
    // only changes HOW the SIGKILL is sent (see stopProcessGroup), never whether.
    proc.exited
      .then(
        (exitCode) => {
          leaderExited = true;
          latch.settle({ kind: "exit", exitCode });
        },
        // A rejected exit is not stall evidence: it settles the latch as an error
        // so the pre-latch result (returned by the catch below) is unchanged.
        (error: unknown) => latch.settle({ kind: "error", error }),
      )
      // Floating by design: .catch keeps a rejected proc.exited from surfacing as
      // an unhandled rejection, which the crash handler would escalate to a full
      // teardown — including a settle callback that itself throws.
      .catch(() => {});

    // The monitor arms a silence deadline the moment it is created, so it comes
    // AFTER spawn — a spawn failure must leave neither a timer nor a callback
    // behind — and it is disposed if stream setup throws before the latch settles.
    let monitor: GateStallMonitor | undefined;
    let collectors: { stdout: StreamCollector; stderr: StreamCollector };
    try {
      monitor = startStallMonitor(opts.stallDetection, latch);
      // Rule 07: both streams are read concurrently with the leader's exit, and
      // every chunk reaches the detector as it arrives, so a repeated line stops
      // a live child long before its wall deadline.
      collectors = openCollectors(proc, monitor);
    } catch (error) {
      monitor?.dispose();
      throw error;
    }

    // setTimeout, not Bun.sleep: the wall deadline must be cancellable mid-flight
    // (forbidden-patterns-source.md, the clearTimeout exception).
    const killTimer = _qualityRunnerDeps.setTimeout(() => latch.settle({ kind: "deadline" }), timeoutMs);

    const terminal = await latch.terminal;
    // Settlement disarms everything this invocation armed — the wall deadline, the
    // silence deadline and every detector callback — so nothing late can change
    // the outcome and no timer outlives the call.
    _qualityRunnerDeps.clearTimeout(killTimer);
    monitor?.dispose();

    if (terminal.kind === "error") throw terminal.error;

    if (terminal.kind === "exit") {
      const [stdout, stderr] = await drainOutputStreams({
        stdout: collectors.stdout,
        stderr: collectors.stderr,
        pid: proc.pid,
        timedOut: false,
      });
      const durationMs = Date.now() - startTime;
      const output = [stdout, stderr].filter(Boolean).join("\n");

      logger?.[level]("quality", `${commandName} completed`, {
        storyId,
        commandName,
        command,
        workdir,
        exitCode: terminal.exitCode,
        durationMs,
        timedOut: false,
      });

      return {
        commandName,
        command,
        success: terminal.exitCode === 0,
        exitCode: terminal.exitCode,
        output,
        durationMs,
        timedOut: false,
      };
    }

    // A detector stop takes the SAME lane as a wall deadline, and each invocation
    // enters it at most once: the latch has already settled, so no later callback
    // can start a second termination sequence.
    await stopProcessGroup(_qualityRunnerDeps, {
      pid: proc.pid,
      gracePeriodMs: SIGKILL_GRACE_PERIOD_MS,
      exited: proc.exited,
      hasLeaderExited: () => leaderExited,
    });
    const [stdout, stderr] = await drainOutputStreams({
      stdout: collectors.stdout,
      stderr: collectors.stderr,
      pid: proc.pid,
      timedOut: true,
    });

    const durationMs = Date.now() - startTime;
    const partial = [stdout, stderr].join("\n");
    const output =
      terminal.kind === "stalled"
        ? stoppedOutput({ commandName, reason: terminal.reason, partial, origin })
        : timedOutOutput(commandName, timeoutMs, origin === "agent-tool" ? partial : "");
    const stoppedData = { storyId, commandName, command, workdir, durationMs, timedOut: true };

    if (terminal.kind === "stalled") {
      // Structured evidence only — never a copy of the repeated line or raw output.
      logger?.warn("quality", `${commandName} stopped early`, { ...stoppedData, ...stopLogFields(terminal.reason) });
    } else {
      logger?.warn("quality", `${commandName} timed out`, stoppedData);
    }

    const base = { commandName, command, success: false, exitCode: -1, output, durationMs, timedOut: true };
    return terminal.kind === "stalled" ? { ...base, stopReason: terminal.reason } : base;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    return {
      commandName,
      command,
      success: false,
      exitCode: -1,
      output: errorMessage(error),
      durationMs,
      timedOut: false,
    };
  }
}

/**
 * Run a quality command, dispatching to every entry of a list-valued spec
 * (nax#1990). A string spec runs once. A list spec runs each entry
 * sequentially — even after one fails — and folds the per-step results into
 * one via {@link aggregateResults}, so a multi-step gate reports all its
 * failures in one invocation instead of the first `&&`-chain link hiding the
 * rest.
 */
export async function runQualityCommand(opts: QualityCommandOptions): Promise<QualityCommandResult> {
  // US-006: the command comes from merged config (or an auto-detected script)
  // and runs unsandboxed — refuse before any early return unless a trust
  // decision covers the workdir.
  await assertTrusted(opts.workdir, "quality-command");
  const { command } = opts;
  if (typeof command === "string") {
    return await runSingleCommand({ ...opts, command });
  }
  const steps = normalizeCommandSpec(opts.command);

  if (steps.length === 0) {
    return {
      commandName: opts.commandName,
      command: "",
      success: false,
      exitCode: -1,
      output: `[nax] ${opts.commandName} skipped: empty command`,
      durationMs: 0,
      timedOut: false,
    };
  }

  if (steps.length === 1 && steps[0] !== undefined) {
    return await runSingleCommand({ ...opts, command: steps[0] });
  }

  const results: QualityCommandResult[] = [];
  for (const step of steps) {
    // Sequential and unconditional: the whole point is that a failing step
    // does not stop the ones after it (nax#1990). Sequential rather than
    // parallel because these share a working directory and a build cache.
    results.push(await runSingleCommand({ ...opts, command: step }));
  }
  return aggregateResults(opts.commandName, results);
}
