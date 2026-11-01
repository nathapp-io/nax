/**
 * Agent hook execution (US-003)
 *
 * Runs ONE configured agent hook (`hooks.json` → `agent.<Event>[n]`) as a child
 * process and normalizes the result into an {@link AgentHookRun}. The spawn
 * pattern is the lifecycle hooks' pattern (`hooks/runner.ts`): argv through
 * `parseCommandToArgv` (never a shell), the same `validateHookCommand` lint in
 * front of it, and `buildAllowedEnv` for the child's environment.
 *
 * The contract a hook answers on: one JSON object on stdin (the payload), and
 * the answer is the exit code — `0` success (an optional JSON object on stdout
 * is returned as `json`), `2` block (reason = trimmed stderr), anything else an
 * error. A hook is user-supplied code: every failure — a trust refusal, a lint
 * rejection, a spawn failure, a deadline — is an `AgentHookRun`, never a
 * rejection.
 *
 * `runner.ts` is out of scope for the agent-hooks work, so the stream-capture /
 * drain helpers and the deadline escalation are mirrored here rather than
 * imported. `killProcessGroup` comes from `@nathapp/nax-agent/internal`, as it
 * does there, so the deadline reaches a hook's whole process group.
 */

import { errorMessage, killProcessGroup } from "@nathapp/nax-agent/internal";
import { buildAllowedEnv } from "@/agents/shared";
import { getLogger } from "@/logger";
import { assertTrusted } from "@/trust";
import { parseCommandToArgv } from "@/utils/command-argv";
import { validateHookCommand } from "../runner";
import type { AgentHookEntry, AgentHookRun } from "./types";

/** Grace period after SIGTERM before a hook that ignored it is killed with SIGKILL. */
export const AGENT_HOOK_KILL_GRACE_MS = 5000;

/** How long output may keep draining after the hook process exited or was killed. */
export const AGENT_HOOK_DRAIN_MS = 2000;

/** Deadline budget a handler keeps back for its own bookkeeping, inside the hook's timeout. */
export const AGENT_HOOK_HANDLER_MARGIN_MS = 1000;

/**
 * How often a killed hook's process group is probed while waiting for it to
 * empty. Small enough that the wait ends as soon as the last descendant is
 * gone, large enough that a TERM-resistant descendant costs a handful of
 * `kill(-pgid, 0)` calls per second rather than a busy loop.
 */
const AGENT_HOOK_GROUP_POLL_MS = 25;

/** The reason a command with no argv answers with. */
const EMPTY_COMMAND_REASON = "empty command";

/** Injectable for tests; each value is read at call time, never captured at import. */
export const _runAgentHookDeps: {
  /** Grace between SIGTERM and SIGKILL for a hook that ignores the deadline. */
  killGraceMs: number;
  /** Bound on draining a hook's output once it exited or was killed. */
  drainMs: number;
  /** The trust assertion a project entry goes through before it is spawned. */
  assertTrusted: typeof assertTrusted;
} = {
  killGraceMs: AGENT_HOOK_KILL_GRACE_MS,
  drainMs: AGENT_HOOK_DRAIN_MS,
  assertTrusted,
};

/** A stream read incrementally, so what arrived before a deadline is kept. */
interface StreamCapture {
  /** Resolves at EOF (or on a read error). */
  done: Promise<void>;
  /** Everything decoded so far. */
  text: () => string;
  /** Stop reading; releases a pending read. */
  cancel: () => void;
}

/** What one spawned hook produced, before the exit code is interpreted. */
interface HookProcessOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function captureStream(stream: ReadableStream<Uint8Array>): StreamCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let collected = "";
  const done = (async () => {
    try {
      for (;;) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        collected += decoder.decode(value, { stream: true });
      }
    } catch {
      // A read error ends the capture; what arrived before it is still returned.
    }
    collected += decoder.decode();
  })();
  return {
    done,
    text: () => collected,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

/** Wait for EOF or the deadline, whichever is first; the caller reads `capture.text()` afterwards. */
async function waitForDrain(capture: StreamCapture, deadlineMs: number): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, deadlineMs);
  });
  try {
    await Promise.race([capture.done, deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** How a command is named in a reason, so a multi-hook config says which one failed. */
function describeCommand(command: string): string {
  return `Agent hook command "${command}"`;
}

/**
 * Wait for a killed hook's process group to empty, or for the SIGKILL
 * escalation to fire — whichever comes first.
 *
 * Awaiting the escalation ALONE sits out the whole kill grace even when the
 * group empties milliseconds after the leader exits: a descendant that already
 * took the SIGTERM is still a member at the instant `proc.exited` resolves (it
 * is dying, or a zombie until it is reaped), so the probe in `collectOutput`
 * legitimately sees it. That made a hook with a 100 ms deadline take 5.1 s
 * instead of ~0.1 s, intermittently — 5105-5107 ms measured on this host when
 * the descendant was observed. Polling keeps the escalation for a descendant
 * that IGNORES SIGTERM and ends the wait as soon as nothing is left to kill.
 *
 * setTimeout, not Bun.sleep, for the reason `collectOutput` gives: the polling
 * handle is cancelled mid-flight, here in the `finally`.
 */
async function waitForGroupExit(pid: number, escalation: Promise<void>): Promise<void> {
  let pollId: ReturnType<typeof setTimeout> | undefined;
  const drained = new Promise<void>((resolve) => {
    const poll = (): void => {
      if (!killProcessGroup(pid, 0, { singleProcessFallback: false })) {
        resolve();
        return;
      }
      pollId = setTimeout(poll, AGENT_HOOK_GROUP_POLL_MS);
    };
    poll();
  });
  try {
    await Promise.race([escalation, drained]);
  } finally {
    clearTimeout(pollId);
  }
}

/** The object in a hook's stdout, or undefined when it is not a non-null non-array object. */
function parseJsonObject(text: string): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/** Map one spawned hook's exit code and output onto the hook's answer. */
function toRun(entry: AgentHookEntry, outcome: HookProcessOutcome): AgentHookRun {
  const command = describeCommand(entry.command);
  if (outcome.timedOut) return { kind: "error", reason: `${command} timed out after ${entry.timeoutMs}ms` };

  const stdout = outcome.stdout.trim();
  const stderr = outcome.stderr.trim();

  if (outcome.exitCode === 0) {
    const json = parseJsonObject(stdout);
    return json === undefined ? { kind: "ok", stdout } : { kind: "ok", stdout, json };
  }
  // 2 is the block code; the reason is the hook's own trimmed stderr, and a
  // silent block still has to say which hook answered.
  if (outcome.exitCode === 2) {
    return { kind: "block", reason: stderr.length > 0 ? stderr : `${command} blocked the call without a reason` };
  }
  const detail = stderr.length > 0 ? `: ${stderr}` : "";
  return { kind: "error", reason: `${command} exited with code ${outcome.exitCode}${detail}` };
}

/**
 * Run one configured agent hook.
 *
 * Never rejects: a trust refusal, a lint rejection, a spawn failure and a
 * deadline all come back as `{ kind: "error" }`. Every call logs one
 * `agent-hooks` debug line, carrying the event, the command, the outcome kind
 * and the duration.
 */
export async function runAgentHook(input: {
  readonly entry: AgentHookEntry;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}): Promise<AgentHookRun> {
  const startedAt = performance.now();
  const run = await executeAgentHook(input.entry, input.payload, input.cwd);
  logRun(input.entry, input.payload, run, Math.round(performance.now() - startedAt));
  return run;
}

/** One debug line per execution; the handlers (US-004/US-005) read these fields. */
function logRun(
  entry: AgentHookEntry,
  payload: Readonly<Record<string, unknown>>,
  run: AgentHookRun,
  durationMs: number,
): void {
  const hookEvent = payload.hook_event_name;
  getLogger().debug("agent-hooks", "Agent hook executed", {
    ...(typeof hookEvent === "string" ? { event: hookEvent } : {}),
    command: entry.command,
    kind: run.kind,
    durationMs,
  });
}

/** Run one hook, mapping every failure onto an AgentHookRun. */
async function executeAgentHook(
  entry: AgentHookEntry,
  payload: Readonly<Record<string, unknown>>,
  cwd: string,
): Promise<AgentHookRun> {
  if (entry.command.trim().length === 0) return { kind: "error", reason: EMPTY_COMMAND_REASON };

  // A project entry is repository-controlled code: assert trust before anything
  // is done with it, exactly as `fireHook` does for a project lifecycle hook.
  // Global entries are operator-machine controlled and exempt (US-003 AC-22).
  if (entry.origin === "project") {
    const refusal = await trustRefusal(entry.command, cwd);
    if (refusal !== null) return { kind: "error", reason: refusal };
  }

  try {
    validateHookCommand(entry.command);
  } catch (err) {
    return { kind: "error", reason: `${describeCommand(entry.command)} was rejected: ${errorMessage(err)}` };
  }

  const argv = parseCommandToArgv(entry.command);
  if (argv.length === 0) return { kind: "error", reason: EMPTY_COMMAND_REASON };

  return spawnHook(argv, entry, payload, cwd);
}

/** The trust check's refusal reason, or null when the project is trusted. */
async function trustRefusal(command: string, cwd: string): Promise<string | null> {
  try {
    await _runAgentHookDeps.assertTrusted(cwd, "agent-hooks");
    return null;
  } catch (err) {
    return `${describeCommand(command)} was refused by the trust check: ${errorMessage(err)}`;
  }
}

/** Spawn the hook's argv and collect its output; a failed start is an error run. */
async function spawnHook(
  argv: string[],
  entry: AgentHookEntry,
  payload: Readonly<Record<string, unknown>>,
  cwd: string,
): Promise<AgentHookRun> {
  let proc: ReturnType<typeof spawnHookProcess>;
  try {
    proc = spawnHookProcess(argv, payload, cwd);
  } catch (err) {
    return { kind: "error", reason: `${describeCommand(entry.command)} could not be started: ${errorMessage(err)}` };
  }
  const outcome = await collectOutput(proc, entry.timeoutMs);
  return toRun(entry, outcome);
}

/** Spawn with the hook's stdin payload; `detached` makes the hook its own process group. */
function spawnHookProcess(argv: string[], payload: Readonly<Record<string, unknown>>, cwd: string) {
  // detached: the hook leads its own process group, so the deadline's
  // killProcessGroup(-pid) reaches every process it started.
  // nax-git-env-allow: not git: agent hook argv (hooks.json agent.<Event>.command)
  return Bun.spawn(argv, {
    cwd,
    stdin: new Response(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: buildAllowedEnv(),
    detached: true,
  });
}

/**
 * Collect the hook's output alongside its exit code.
 *
 * Both streams are read incrementally while `proc.exited` is awaited, so output
 * larger than the pipe buffer cannot deadlock and whatever arrived before a
 * deadline is kept. Two bounds apply: the hook's own deadline (SIGTERM to the
 * process group, then SIGKILL after the grace period) and a drain bound after
 * exit, because a hook that exited 0 can leave a background child holding the
 * pipes open.
 */
async function collectOutput(
  proc: ReturnType<typeof spawnHookProcess>,
  timeoutMs: number,
): Promise<HookProcessOutcome> {
  let timedOut = false;
  let sigkillFired = false;
  let sigkillId: ReturnType<typeof setTimeout> | undefined;
  let sigkillSent: Promise<void> | undefined;
  // setTimeout, not Bun.sleep: both timers must be cancellable mid-flight
  // (forbidden-patterns-source.md, the clearTimeout exception).
  const killId = setTimeout(() => {
    timedOut = true;
    killProcessGroup(proc.pid, "SIGTERM");
    // A single SIGTERM is not a deadline. A hook that traps or ignores it leaves
    // `proc.exited` unresolved forever, and a descendant that ignores it outlives
    // a leader that did exit — so the escalation arms here and is settled once
    // the group is empty (see below), not when the leader happens to exit.
    sigkillSent = new Promise<void>((resolve) => {
      sigkillId = setTimeout(() => {
        sigkillFired = true;
        killProcessGroup(proc.pid, "SIGKILL", { singleProcessFallback: false });
        resolve();
      }, _runAgentHookDeps.killGraceMs);
    });
  }, timeoutMs);

  const stdoutCapture = captureStream(proc.stdout);
  const stderrCapture = captureStream(proc.stderr);
  const exitCode = await proc.exited;
  clearTimeout(killId);

  // The leader's exit says nothing about the rest of its group. A pending
  // SIGKILL is awaited while the group still has a member (signal 0 probes
  // WITHOUT delivering anything, and polling ends the wait as soon as it is
  // empty) and its timer cancelled once it is, so no timer outlives the call
  // and no TERM-resistant descendant is left running.
  // `singleProcessFallback` stays off: the reap of the leader frees its pid for
  // reuse, and `detached` guarantees the group kill targets the hook's own group.
  if (sigkillId !== undefined && sigkillSent !== undefined) {
    const membersLeft = !sigkillFired && killProcessGroup(proc.pid, 0, { singleProcessFallback: false });
    if (membersLeft) await waitForGroupExit(proc.pid, sigkillSent);
    clearTimeout(sigkillId);
  }

  await Promise.all([
    waitForDrain(stdoutCapture, _runAgentHookDeps.drainMs),
    waitForDrain(stderrCapture, _runAgentHookDeps.drainMs),
  ]);
  stdoutCapture.cancel();
  stderrCapture.cancel();
  return { exitCode, stdout: stdoutCapture.text(), stderr: stderrCapture.text(), timedOut };
}
