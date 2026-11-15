/**
 * executeWithTimeout — stall lifecycle (US-003).
 *
 * The verification executor hands every stdout/stderr chunk to a
 * `createGateStallMonitor` as it arrives, while an independent decoder keeps
 * the original output text. A single terminal latch arbitrates the four things
 * that can end an invocation — leader exit, wall deadline, repeated output and
 * configured silence — and the first one observed while the process is live
 * wins. Everything else (SIGTERM, bounded grace, group probe, SIGKILL, bounded
 * drains, reader cancellation) is the lane a wall timeout already used.
 *
 * Driven on a virtual clock through `_executorDeps` (timers, killProcessGroup,
 * spawn, monitor factory), so every ordering below is controlled by the test
 * rather than by an OS-level simultaneity guarantee.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realOrRaw } from "@nathapp/nax-agent/internal";
import {
  cleanupTempDir,
  type FakeClock,
  makeFakeClock,
  makeSpawn,
  makeSpawnResult,
  makeTempDir,
  type SpawnStub,
  useUntrustedRegistry,
  waitForCondition,
} from "@test/helpers";
import { markTrusted, resetTrustRegistry } from "@/trust";
import { createGateStallMonitor } from "@/utils/gate-stall";
import type { TestExecutionResult } from "@/verification";
import { _executorDeps, executeWithTimeout } from "@/verification/executor";

/** The root `test/preload.ts` trusts, and `useUntrustedRegistry` restores. */
const PRELOADED_ROOT = "/";

const TIMEOUT_S = 1;
const TIMEOUT_MS = TIMEOUT_S * 1_000;
const GRACE_MS = 5_000;
const DRAIN_MS = 500;
const SILENCE_S = 2;
/** Wall deadline used by every silence scenario: it must outlive the silence. */
const LONG_TIMEOUT_S = 30;
const PID = 8765;

interface KillCall {
  pid: number;
  signal: string | number;
  fallback: boolean | undefined;
}

interface ArmedTimer {
  ms: number;
  fired: boolean;
  run: () => void;
}

/** Stream that never enqueues and never closes — a child that is still running. */
function stalledStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      /* nothing: reads stay pending until the test cancels or ends it */
    },
  });
}

/** Stream that delivers `chunks` immediately and then stays open — a live child. */
function liveStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
}

/** Stream that delivers `chunks` and then closes — a finished child. */
function closedStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/**
 * Stream that delivers `chunks` and then fails — a broken pipe. `pull` hands
 * over one chunk per read, so the failure genuinely follows bytes the consumer
 * already took rather than discarding a queue (`controller.error()` resets it).
 */
function failingStream(chunks: string[], error = new Error("broken pipe")): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.error(error);
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

/** A stream with a recordable `cancel`, so reader cancellation is observable. */
function cancellableStall(): { stream: ReadableStream<Uint8Array>; cancels: () => number } {
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancels += 1;
    },
    start() {
      /* wedged: the reader stays pending until it is cancelled */
    },
  });
  return { stream, cancels: () => cancels };
}

/** `blocks` chunks of `size` bytes — larger than any OS pipe buffer. */
function bulkStream(fill: string, blocks: number, size: number): ReadableStream<Uint8Array> {
  const block = new TextEncoder().encode(fill.repeat(size));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < blocks; i++) controller.enqueue(block);
      controller.close();
    },
  });
}

interface SpawnSpec {
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  /** Omit to keep the leader live until the test resolves `manualExit`. */
  exited?: Promise<number>;
}

let original: typeof _executorDeps;
let clock: FakeClock;
let armed: ArmedTimer[];
let kills: KillCall[];
let groupAlive: boolean;
let leaderDiesOnSigterm: boolean;
let leaderExitCode: number;
let leaderExitsOnSigterm: number;
let monitorCalls: number;
let spawnStub: SpawnStub;
let manualExit: { promise: Promise<number>; resolve: (code: number) => void };

function installDeps(): void {
  original = { ..._executorDeps };
  clock = makeFakeClock();
  armed = [];
  kills = [];
  groupAlive = true;
  leaderDiesOnSigterm = true;
  leaderExitCode = 0;
  leaderExitsOnSigterm = 0;
  monitorCalls = 0;

  let resolveExit: (code: number) => void = () => {};
  manualExit = {
    promise: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
    resolve: (code) => resolveExit(code),
  };

  _executorDeps.setTimeout = (_fn, ms) => {
    const timer: ArmedTimer = {
      ms,
      fired: false,
      run: () => {
        timer.fired = true;
        _fn();
      },
    };
    armed.push(timer);
    return clock.setTimeout(timer.run, ms);
  };
  _executorDeps.clearTimeout = (handle) => clock.clearTimeout(handle as number);
  _executorDeps.killProcessGroup = (pid, signal, opts) => {
    kills.push({ pid, signal, fallback: opts?.singleProcessFallback });
    if (signal === 0) return groupAlive;
    if (signal === "SIGTERM" && leaderDiesOnSigterm) {
      leaderExitsOnSigterm += 1;
      resolveExit(leaderExitCode);
    }
    return true;
  };
  _executorDeps.createGateStallMonitor = (options) => {
    monitorCalls += 1;
    return createGateStallMonitor(options);
  };

  stubSpawn();
}

function restoreDeps(): void {
  Object.assign(_executorDeps, original);
}

/** Install a spawn stub; by default a live, silent child whose exit never settles. */
function stubSpawn(spec: SpawnSpec = {}): void {
  spawnStub = makeSpawn(() => {
    const proc = makeSpawnResult({ pid: PID });
    Object.defineProperty(proc, "stdout", { value: spec.stdout ?? stalledStream() });
    Object.defineProperty(proc, "stderr", { value: spec.stderr ?? stalledStream() });
    Object.defineProperty(proc, "exited", { value: spec.exited ?? manualExit.promise });
    return proc;
  });
  _executorDeps.spawn = spawnStub.spawn;
}

/**
 * Step virtual time until the invocation settles. The settling code arms its
 * next timer a few microtasks after the previous one fires, so a single
 * `advance()` cannot know how far to jump.
 */
async function stepUntilSettled(pending: Promise<unknown>, stepMs = DRAIN_MS): Promise<void> {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 60 && !settled; i++) await clock.advance(stepMs);
  if (!settled) throw new Error("executeWithTimeout never settled on the virtual clock");
}

/** Wait until the executor has spawned, so the test can resolve the leader's exit. */
async function waitForSpawn(): Promise<void> {
  await waitForCondition(() => spawnStub.calls.length > 0);
}

function stallOptions(overrides: { repeatedLineThreshold?: number; silenceTimeoutSeconds?: number }): {
  stallDetection: { repeatedLineThreshold: number; silenceTimeoutSeconds: number };
  gracePeriodMs: number;
  drainTimeoutMs: number;
} {
  return {
    stallDetection: {
      repeatedLineThreshold: overrides.repeatedLineThreshold ?? 0,
      silenceTimeoutSeconds: overrides.silenceTimeoutSeconds ?? 0,
    },
    gracePeriodMs: GRACE_MS,
    drainTimeoutMs: DRAIN_MS,
  };
}

const windowOptions = { gracePeriodMs: GRACE_MS, drainTimeoutMs: DRAIN_MS };

/** Arm a repetition stop: two identical stdout lines, then the process stays live. */
async function startRepeatStop(): Promise<{ pending: Promise<TestExecutionResult> }> {
  stubSpawn({ stdout: liveStream("dup-line\n", "dup-line\n") });
  const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, stallOptions({ repeatedLineThreshold: 2 }));
  await waitForCondition(() => kills.length > 0);
  return { pending };
}

describe("executeWithTimeout — detector stops a live process", () => {
  beforeEach(installDeps);
  afterEach(restoreDeps);

  // AC-1
  test("AC-1: feeds live stdout and stderr chunks to the real detector and stops before the wall deadline", async () => {
    stubSpawn({
      stdout: liveStream("step 1\n", "step 2\n"),
      stderr: liveStream("Error: same\n", "Error: same\n", "Error: same\n"),
    });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, stallOptions({ repeatedLineThreshold: 3 }));
    await waitForCondition(() => kills.length > 0);

    expect(monitorCalls).toBe(1);
    // The repetition was observed from chunks that arrived before any exit.
    expect(leaderExitsOnSigterm).toBe(1);
    await stepUntilSettled(pending);
    const result = await pending;

    expect(result.stopReason).toEqual({ kind: "repeated-output", stream: "stderr", count: 3, threshold: 3 });
    // The wall deadline never fired: the detector ended the live process first.
    expect(armed.filter((timer) => timer.ms === TIMEOUT_MS && timer.fired)).toEqual([]);
  });

  // F1 (fix round 1) — a monitor armed before a failing spawn would keep its
  // silence timer on the event loop and its callback retained after the caller
  // sees the rejection.
  test("F1: a spawn failure leaves no detector monitor or timer behind", async () => {
    const failing = makeSpawn(() => {
      throw new Error("spawn ENOENT");
    });
    _executorDeps.spawn = failing.spawn;

    await expect(
      executeWithTimeout("bun test", LONG_TIMEOUT_S, undefined, stallOptions({ silenceTimeoutSeconds: SILENCE_S })),
    ).rejects.toThrow("spawn ENOENT");

    // The silence deadline armed by the monitor is the leak: nothing disposed it.
    expect(clock.pending()).toBe(0);
    expect(monitorCalls).toBe(0);
  });

  // F1 (fix round 1) — the same leak through the other setup step: a stream that
  // cannot be read throws after the monitor exists, so the catch must dispose it.
  test("F1: a stream-setup failure disposes the monitor it already created", async () => {
    const locked = liveStream("never read\n");
    locked.getReader(); // locks the stream, so openCollectors' getReader() throws
    stubSpawn({ stdout: locked, stderr: closedStream() });

    await expect(
      executeWithTimeout("bun test", LONG_TIMEOUT_S, undefined, stallOptions({ silenceTimeoutSeconds: SILENCE_S })),
    ).rejects.toThrow();

    // The monitor WAS created (setup got that far) and was then disposed.
    expect(monitorCalls).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  // AC-2, AC-3
  test("AC-2/AC-3: a repeated-output stop returns the raw timeout-lane result with its structured reason", async () => {
    stubSpawn({ stdout: liveStream("dup-line\n", "dup-line\n") });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, stallOptions({ repeatedLineThreshold: 2 }));
    await stepUntilSettled(pending);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.timeout).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.childProcessesKilled).toBe(true);
    expect(result.countsTowardEscalation).toBe(false);
    expect(result.stopReason).toEqual({ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 });
  });

  // AC-2, AC-3
  test("AC-2/AC-3: an opted-in silence stop returns the raw timeout-lane result with its structured reason", async () => {
    const pending = executeWithTimeout(
      "bun test",
      LONG_TIMEOUT_S,
      undefined,
      stallOptions({ silenceTimeoutSeconds: SILENCE_S }),
    );
    await waitForSpawn();
    await stepUntilSettled(pending);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.timeout).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.childProcessesKilled).toBe(true);
    expect(result.countsTowardEscalation).toBe(false);
    expect(result.stopReason).toEqual({ kind: "silence", silenceTimeoutSeconds: SILENCE_S });
  });

  // AC-4
  test("AC-4: the repetition error names the stream and threshold, not the wall deadline", async () => {
    stubSpawn({ stdout: liveStream("same\n", "same\n", "same\n") });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, stallOptions({ repeatedLineThreshold: 3 }));
    await stepUntilSettled(pending);
    const result = await pending;
    const error = result.error ?? "";

    expect(error.startsWith("EXECUTION_STALLED:")).toBe(true);
    expect(error).toContain("stdout");
    expect(error).toContain("threshold 3");
    expect(error).not.toContain("EXECUTION_TIMEOUT");
    expect(error).not.toContain("exceeded");
  });

  // AC-4
  test("AC-4: the silence error names the silence setting, not the wall deadline", async () => {
    const pending = executeWithTimeout(
      "bun test",
      LONG_TIMEOUT_S,
      undefined,
      stallOptions({ silenceTimeoutSeconds: SILENCE_S }),
    );
    await waitForSpawn();
    await stepUntilSettled(pending);
    const result = await pending;
    const error = result.error ?? "";

    expect(error.startsWith("EXECUTION_STALLED:")).toBe(true);
    expect(error).toContain(`silenceTimeoutSeconds: ${SILENCE_S}`);
    expect(error).toContain(`${SILENCE_S}s`);
    expect(error).not.toContain("EXECUTION_TIMEOUT");
    expect(error).not.toContain("exceeded");
  });
});

describe("executeWithTimeout — stopReason is absent when nothing stalled", () => {
  beforeEach(installDeps);
  afterEach(restoreDeps);

  // AC-5
  test("AC-5: an ordinary wall timeout carries no stopReason", async () => {
    stubSpawn();
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, windowOptions);
    await waitForSpawn();
    await clock.advance(TIMEOUT_MS);
    await stepUntilSettled(pending);
    const result = await pending;

    expect(result.timeout).toBe(true);
    expect(armed.some((timer) => timer.ms === TIMEOUT_MS && timer.fired)).toBe(true);
    expect(Object.keys(result)).not.toContain("stopReason");
  });

  // AC-6
  test("AC-6: a normal exit carries no stopReason", async () => {
    stubSpawn({ stdout: closedStream("all good\n"), stderr: closedStream() });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, stallOptions({ repeatedLineThreshold: 2 }));
    await waitForSpawn();
    manualExit.resolve(0);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(result.timeout).toBe(false);
    expect(monitorCalls).toBe(1);
    expect(Object.keys(result)).not.toContain("stopReason");
  });

  // AC-7
  test("AC-7: a stream error carries no stopReason", async () => {
    stubSpawn({ stdout: failingStream(["one\n", "two\n"]), stderr: closedStream() });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, stallOptions({ repeatedLineThreshold: 2 }));
    await waitForSpawn();
    manualExit.resolve(0);
    const result = await pending;

    expect(result.timeout).toBe(false);
    expect(monitorCalls).toBe(1);
    expect(Object.keys(result)).not.toContain("stopReason");
  });

  // AC-7
  test("AC-7: a drain-deadline expiry carries no stopReason", async () => {
    stubSpawn({ stdout: liveStream("partial\n"), stderr: stalledStream() });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, stallOptions({ repeatedLineThreshold: 9 }));
    await waitForSpawn();
    manualExit.resolve(0);
    await stepUntilSettled(pending);
    const result = await pending;

    expect(result.timeout).toBe(false);
    expect(Object.keys(result)).not.toContain("stopReason");
  });

  // AC-8
  test("AC-8: without stallDetection a quiet live process runs to its ordinary wall timeout", async () => {
    stubSpawn();
    const started = clock.now();
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, windowOptions);
    await waitForSpawn();
    await stepUntilSettled(pending);
    const result = await pending;

    expect(result.timeout).toBe(true);
    expect(result.error?.startsWith("EXECUTION_TIMEOUT:")).toBe(true);
    expect(clock.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS);
    expect(armed.some((timer) => timer.ms === TIMEOUT_MS && timer.fired)).toBe(true);
  });

  // AC-9
  test("AC-9: without stallDetection no monitor is created, so repeated output cannot stop the run", async () => {
    stubSpawn({ stdout: liveStream("dup\n", "dup\n", "dup\n", "dup\n") });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, windowOptions);
    await waitForSpawn();
    await stepUntilSettled(pending);
    const result = await pending;

    expect(monitorCalls).toBe(0);
    expect(result.stopReason).toBeUndefined();
    expect(result.error?.startsWith("EXECUTION_TIMEOUT:")).toBe(true);
  });
});

describe("executeWithTimeout — one process-group cleanup sequence", () => {
  beforeEach(installDeps);
  afterEach(restoreDeps);

  // AC-10
  test("AC-10: a detector stop runs exactly one SIGTERM-to-SIGKILL group sequence", async () => {
    const { pending } = await startRepeatStop();
    await stepUntilSettled(pending);
    await pending;

    expect(kills.map((kill) => kill.signal)).toEqual(["SIGTERM", 0, "SIGKILL"]);
    expect(kills.filter((kill) => kill.signal === "SIGTERM")).toHaveLength(1);
    expect(kills.filter((kill) => kill.signal === "SIGKILL")).toHaveLength(1);
  });

  // AC-11
  test("AC-11: surviving group members are SIGKILLed after leader exit with the pid fallback off", async () => {
    const { pending } = await startRepeatStop();
    await stepUntilSettled(pending);
    await pending;

    expect(leaderExitsOnSigterm).toBe(1);
    expect(kills.filter((kill) => kill.signal === "SIGKILL")).toEqual([
      { pid: PID, signal: "SIGKILL", fallback: false },
    ]);
  });

  // AC-12
  test("AC-12: escalation is cancelled when the stopped group is already empty", async () => {
    groupAlive = false;
    const started = clock.now();
    const { pending } = await startRepeatStop();
    await stepUntilSettled(pending);
    await pending;

    expect(kills.some((kill) => kill.signal === "SIGKILL")).toBe(false);
    // Cancelled rather than awaited: the call never waits out the grace period.
    expect(clock.now() - started).toBeLessThan(GRACE_MS);
  });

  // AC-13
  test("AC-13: every armed timer is cleared within the bounded drain lifecycle when the group is empty", async () => {
    groupAlive = false;
    const { pending } = await startRepeatStop();
    await stepUntilSettled(pending);
    await pending;

    expect(armed.length).toBeGreaterThan(0);
    expect(clock.pending()).toBe(0);
    expect(armed.filter((timer) => timer.fired && timer.ms === GRACE_MS)).toEqual([]);
  });

  // AC-14
  test("AC-14: a pending reader is cancelled by the drain deadline, leaving no outstanding read", async () => {
    const stdout = cancellableStall();
    const stderr = cancellableStall();
    stubSpawn({ stdout: stdout.stream, stderr: stderr.stream });
    const pending = executeWithTimeout(
      "bun test",
      LONG_TIMEOUT_S,
      undefined,
      stallOptions({ silenceTimeoutSeconds: 1 }),
    );
    await waitForSpawn();
    await stepUntilSettled(pending, DRAIN_MS / 2);
    const result = await pending;

    expect(stdout.cancels()).toBe(1);
    expect(stderr.cancels()).toBe(1);
    expect(result.stopReason).toEqual({ kind: "silence", silenceTimeoutSeconds: 1 });
  });

  // AC-17
  test("AC-17: late stop and deadline callbacks start no second termination sequence", async () => {
    const { pending } = await startRepeatStop();
    await stepUntilSettled(pending);
    await pending;
    const killsAfterRun = [...kills];

    // Every callback the run armed but never fired, invoked late: the latch is
    // already settled, and the detector is disposed, so neither may act.
    for (const timer of armed) if (!timer.fired) timer.run();

    expect(kills).toEqual(killsAfterRun);
    expect(kills.filter((kill) => kill.signal === "SIGTERM")).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });
});

describe("executeWithTimeout — terminal ordering and output fidelity", () => {
  beforeEach(installDeps);
  afterEach(restoreDeps);

  // AC-15
  test("AC-15: an exit observed first wins over a queued detector or deadline event, even with an inherited pipe open", async () => {
    stubSpawn({ stdout: liveStream("finished\n"), stderr: stalledStream() });
    const pending = executeWithTimeout(
      "bun test",
      TIMEOUT_S,
      undefined,
      stallOptions({ repeatedLineThreshold: 100, silenceTimeoutSeconds: 3 }),
    );
    await waitForSpawn();
    manualExit.resolve(0);
    await stepUntilSettled(pending);
    const result = await pending;

    // Both the wall deadline and the detector's silence timer were armed; firing
    // them now is exactly the queued-event-after-exit ordering.
    for (const timer of armed) if (!timer.fired) timer.run();

    expect(result.timeout).toBe(false);
    expect(result.success).toBe(true);
    expect(Object.keys(result)).not.toContain("stopReason");
  });

  // AC-16
  test("AC-16: a detector stop observed first keeps the timeout failure over a later exit 0", async () => {
    const { pending } = await startRepeatStop();
    manualExit.resolve(0);
    await stepUntilSettled(pending);
    const result = await pending;

    expect(result.timeout).toBe(true);
    expect(result.success).toBe(false);
    expect(result.stopReason?.kind).toBe("repeated-output");
  });

  // AC-18
  test("AC-18: a stream error retains already-collected stdout then stderr", async () => {
    stubSpawn({ stdout: failingStream(["kept-out\n"]), stderr: failingStream(["kept-err\n"]) });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, windowOptions);
    await waitForSpawn();
    manualExit.resolve(0);
    const result = await pending;
    const output = result.output ?? "";

    expect(output).toContain("kept-out");
    expect(output).toContain("kept-err");
    expect(output.indexOf("kept-out")).toBeLessThan(output.indexOf("kept-err"));
  });

  // AC-18
  test("AC-18: a drain-deadline expiry retains already-collected stdout then stderr", async () => {
    stubSpawn({ stdout: liveStream("kept-out\n"), stderr: liveStream("kept-err\n") });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, windowOptions);
    await waitForSpawn();
    manualExit.resolve(0);
    await stepUntilSettled(pending);
    const result = await pending;
    const output = result.output ?? "";

    expect(output).toContain("kept-out");
    expect(output).toContain("kept-err");
    expect(output.indexOf("kept-out")).toBeLessThan(output.indexOf("kept-err"));
  });

  // AC-19
  test("AC-19: a stream error does not reclassify a normal exit as a detector stop", async () => {
    stubSpawn({ stdout: failingStream(["dup\n", "dup\n"]), stderr: closedStream() });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, stallOptions({ repeatedLineThreshold: 3 }));
    await waitForSpawn();
    manualExit.resolve(0);
    const result = await pending;

    expect(result.exitCode).toBe(0);
    expect(result.timeout).toBe(false);
    expect(result.success).toBe(true);
    expect(monitorCalls).toBe(1);
    expect(Object.keys(result)).not.toContain("stopReason");
  });

  // AC-20
  test("AC-20: simultaneous output larger than a pipe buffer drains from both streams without deadlock", async () => {
    stubSpawn({ stdout: bulkStream("a", 8, 65_536), stderr: bulkStream("b", 8, 65_536), exited: Promise.resolve(0) });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, windowOptions);
    await waitForSpawn();
    const result = await pending;
    const output = result.output ?? "";

    expect(result.success).toBe(true);
    expect(output.split("a").length - 1).toBeGreaterThanOrEqual(8 * 65_536);
    expect(output).toContain("b".repeat(65_536));
    expect(clock.pending()).toBe(0);
  });

  // AC-21
  test("AC-21: captured output text is unchanged by detector normalization", async () => {
    const line = "\u001b[31m  repeated  \u001b[0m";
    const raw = `${line}\n${line}\n${line}\n`;
    stubSpawn({ stdout: liveStream(raw) });
    const pending = executeWithTimeout("bun test", TIMEOUT_S, undefined, stallOptions({ repeatedLineThreshold: 3 }));
    await stepUntilSettled(pending);
    const result = await pending;

    expect(result.stopReason).toEqual({ kind: "repeated-output", stream: "stdout", count: 3, threshold: 3 });
    expect(result.output).toBe(raw);
  });
});

describe("executeWithTimeout — trust boundary precedes the detector", () => {
  useUntrustedRegistry();
  beforeEach(installDeps);
  afterEach(restoreDeps);

  // AC-22
  test("AC-22: an untrusted cwd is refused before a monitor is created or a child spawned", async () => {
    const project = realOrRaw(makeTempDir("executor-stall-untrusted-"));

    try {
      // Positive control: on a trusted cwd the same call reaches both seams, so
      // the zeroes below measure the refusal rather than a broken stub. The
      // trust registry is emptied by `useUntrustedRegistry` for this suite, so
      // the control has to put the preload's trust back first.
      markTrusted(PRELOADED_ROOT);
      stubSpawn({ stdout: closedStream(), stderr: closedStream(), exited: Promise.resolve(0) });
      await executeWithTimeout("echo hi", 5, undefined, { stallDetection: { repeatedLineThreshold: 2 } });
      expect(monitorCalls).toBe(1);
      expect(spawnStub.calls).toHaveLength(1);

      resetTrustRegistry();
      monitorCalls = 0;
      spawnStub.calls.length = 0;

      await expect(
        executeWithTimeout("echo hi", 5, undefined, {
          cwd: project,
          stallDetection: { repeatedLineThreshold: 2 },
        }),
      ).rejects.toMatchObject({ code: "PROJECT_UNTRUSTED", context: { surface: "test-command" } });

      expect(monitorCalls).toBe(0);
      expect(spawnStub.calls).toHaveLength(0);
    } finally {
      cleanupTempDir(project);
    }
  });
});
