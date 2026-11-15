/**
 * Stall lifecycle of `runQualityCommand` (review-and-gate-guards US-005).
 *
 * The quality runner now feeds every live chunk to `createGateStallMonitor` and
 * arbitrates the four things that can end an invocation — leader exit, wall
 * deadline, repeated output and silence — through one terminal latch, so a
 * detector stop takes the same terminate/drain lane as a wall timeout and a
 * child whose exit never arrives still settles.
 *
 * Nothing here sleeps: timers come from `makeFakeClock` via
 * `_qualityRunnerDeps`, and streams are controlled by the test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realOrRaw } from "@nathapp/nax-agent/internal";
import {
  cleanupTempDir,
  makeFakeClock,
  makeSpawn,
  makeSpawnResult,
  makeTempDir,
  repeatedLinesStream,
  useUntrustedRegistry,
  waitForCondition,
  withTimerSpy,
} from "@test/helpers";
import {
  _qualityRunnerDeps,
  type QualityCommandOptions,
  type QualityCommandResult,
  runQualityCommand,
  TIMEOUT_OUTPUT_TAIL_CHARS,
} from "@/quality/runner";
import { createGateStallMonitor, type GateStopReason } from "@/utils/gate-stall";

const FAKE_PID = 9911;
/** The runner's SIGKILL grace period. */
const GRACE_MS = 5_000;
const TIMEOUT_MS = 60_000;
/** Virtual-clock step: big enough to pass any armed deadline, small enough to stay precise. */
const CLOCK_STEP_MS = 1_000;

const encoder = new TextEncoder();

interface KillCall {
  pid: number;
  signal: string | number;
  singleProcessFallback: boolean | undefined;
}

let original: typeof _qualityRunnerDeps;
let clock: ReturnType<typeof makeFakeClock>;
let kills: KillCall[];
let groupAlive: boolean;
let onSigterm: () => void;

beforeEach(() => {
  original = { ..._qualityRunnerDeps };
  clock = makeFakeClock();
  kills = [];
  groupAlive = false;
  onSigterm = () => {};
  _qualityRunnerDeps.setTimeout = clock.setTimeout as typeof _qualityRunnerDeps.setTimeout;
  _qualityRunnerDeps.clearTimeout = clock.clearTimeout as typeof _qualityRunnerDeps.clearTimeout;
  _qualityRunnerDeps.killProcessGroup = (pid, signal, opts) => {
    kills.push({ pid, signal, singleProcessFallback: opts?.singleProcessFallback });
    // Signal 0 is the liveness probe: it reports whether the group still has a member.
    if (signal === 0) return groupAlive;
    if (signal === "SIGTERM") onSigterm();
    return true;
  };
});

afterEach(() => {
  Object.assign(_qualityRunnerDeps, original);
});

/** The real timer/spawn deps, for the cases that need a real child process. */
function useRealExecution(): void {
  Object.assign(_qualityRunnerDeps, original);
}

interface FakeProc {
  proc: ReturnType<typeof makeSpawnResult>;
  /** Settle the leader's exit — the only way a fake leader ever exits. */
  exit: (code: number) => void;
  /** Reject `proc.exited`, as a failed wait does. */
  reject: (error: unknown) => void;
}

/** A fake process whose exit the test settles explicitly. */
function fakeProc(
  options: {
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    /** Distinct pids keep the kill calls of a list's entries attributable. */
    pid?: number;
  } = {},
): FakeProc {
  const proc = makeSpawnResult({ pid: options.pid ?? FAKE_PID });
  let settle: (code: number) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const exited = new Promise<number>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  Object.defineProperty(proc, "exited", { value: exited });
  if (options.stdout !== undefined) Object.defineProperty(proc, "stdout", { value: options.stdout });
  if (options.stderr !== undefined) Object.defineProperty(proc, "stderr", { value: options.stderr });
  return { proc, exit: (code) => settle(code), reject: (error) => fail(error) };
}

/** A stream that emits `text` and closes — a well-behaved reader. */
function closedStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text !== "") controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** A stream that emits `text` and never closes — the wedged pipe a killed group leaves behind. */
function stalledStream(text: string, onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text !== "") controller.enqueue(encoder.encode(text));
    },
    cancel() {
      onCancel?.();
    },
  });
}

/**
 * A stream that hands over `text` and only fails on the read after it, so the
 * bytes really were collected before the pipe broke.
 */
function failingStream(text: string, error: Error): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(text));
        return;
      }
      controller.error(error);
    },
  });
}

/** A stream whose chunks the test pushes after the run has started; false once it cannot take more. */
function controlledStream(): { stream: ReadableStream<Uint8Array>; push: (text: string) => boolean } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (text) => {
      if (controller === undefined) return false;
      try {
        controller.enqueue(encoder.encode(text));
        return true;
      } catch {
        // The reader was cancelled, so this stream can no longer carry a chunk.
        return false;
      }
    },
  };
}

function installSpawn(proc: ReturnType<typeof makeSpawnResult>) {
  const stub = makeSpawn(() => proc);
  _qualityRunnerDeps.spawn = stub.spawn;
  return stub;
}

const run = (overrides: Partial<QualityCommandOptions> = {}): Promise<QualityCommandResult> =>
  runQualityCommand({
    commandName: "test",
    command: "bun test",
    workdir: "/tmp/project",
    timeoutMs: TIMEOUT_MS,
    ...overrides,
  });

/**
 * Walk a run to settlement on the virtual clock: each step drains microtasks and
 * fires whatever deadline the runner armed inside the next virtual second, so a
 * bounded grace period and bounded drains cost no wall clock.
 */
async function settle(pending: Promise<QualityCommandResult>): Promise<QualityCommandResult> {
  let done = false;
  const tracked = pending.then(
    (value) => {
      done = true;
      return value;
    },
    (error) => {
      done = true;
      throw error;
    },
  );
  for (let step = 0; step < 200 && !done; step++) {
    await clock.advance(CLOCK_STEP_MS);
  }
  return await tracked;
}

/**
 * Walk the virtual clock forward one step at a time until `predicate` holds, for
 * a run the test has to interleave with — a list whose later entry is settled by
 * the test once it has been spawned.
 */
async function advanceUntil(predicate: () => boolean, maxSteps = 200): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    if (predicate()) return;
    await clock.advance(CLOCK_STEP_MS);
  }
  if (!predicate()) throw new Error("[test] the run never reached the awaited state on the virtual clock");
}

// ---------------------------------------------------------------------------
// AC-2 — the stopped result shape
// ---------------------------------------------------------------------------

describe("runQualityCommand — stopped result (AC-2)", () => {
  test("AC-2: a detector stop returns success false, timedOut true, exitCode -1 and the reason", async () => {
    const { proc, exit } = fakeProc({ stdout: closedStream("same line\nsame line\n") });
    onSigterm = () => exit(143);
    installSpawn(proc);

    const result = await settle(run({ stallDetection: { repeatedLineThreshold: 2 } }));

    expect(result).toMatchObject({
      success: false,
      timedOut: true,
      exitCode: -1,
      stopReason: { kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 },
    });
    const reason: GateStopReason | undefined = result.stopReason;
    expect(reason?.kind).toBe("repeated-output");
  });
});

// ---------------------------------------------------------------------------
// AC-3 / AC-4 — what a stopped command exposes
// ---------------------------------------------------------------------------

describe("runQualityCommand — stopped harness output (AC-3, AC-4)", () => {
  test("AC-3: names repeated-output when repetition stopped the command", async () => {
    const { proc, exit } = fakeProc({ stdout: closedStream("same line\nsame line\n") });
    onSigterm = () => exit(143);
    installSpawn(proc);

    const result = await settle(run({ stallDetection: { repeatedLineThreshold: 2 } }));

    expect(result.output.startsWith("[nax] test stopped early: repeated-output")).toBe(true);
    expect(result.output).toContain("stdout");
  });

  test("AC-3: names silence when opted-in silence stopped the command", async () => {
    const { proc, exit } = fakeProc({ stdout: closedStream("") });
    onSigterm = () => exit(143);
    installSpawn(proc);

    const result = await settle(run({ stallDetection: { silenceTimeoutSeconds: 2 } }));

    expect(result.stopReason).toEqual({ kind: "silence", silenceTimeoutSeconds: 2 });
    expect(result.output.startsWith("[nax] test stopped early: silence")).toBe(true);
  });

  test("AC-4: a stopped harness run does not expose its partial diagnostics as a completed run", async () => {
    const diagnostics = "src/a.test.ts:\n(fail) adds numbers [0.42ms]\n(fail) adds numbers [0.42ms]\n";
    const { proc, exit } = fakeProc({ stdout: closedStream(diagnostics), stderr: closedStream("more diagnostics\n") });
    onSigterm = () => exit(143);
    installSpawn(proc);

    const result = await settle(run({ commandName: "test", stallDetection: { repeatedLineThreshold: 2 } }));

    expect(result.timedOut).toBe(true);
    expect(result.output).not.toContain("(fail)");
    expect(result.output).not.toContain("src/a.test.ts");
    expect(result.output).not.toContain("more diagnostics");
    expect(result.output.startsWith("[nax] test stopped early: repeated-output")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5 / AC-6 — agent-tool output and opt-in
// ---------------------------------------------------------------------------

describe("runQualityCommand — agent-tool stall policy (AC-5, AC-6)", () => {
  test("AC-5: an explicitly stalled agent-tool run keeps its bounded line-boundary tail", async () => {
    const stdout = `${"x".repeat(TIMEOUT_OUTPUT_TAIL_CHARS)}\npkg/a.test.ts ok\nsame line\nsame line\n`;
    const { proc, exit } = fakeProc({ stdout: closedStream(stdout) });
    onSigterm = () => exit(143);
    installSpawn(proc);

    const result = await settle(
      run({ commandName: "test", origin: "agent-tool", stallDetection: { repeatedLineThreshold: 2 } }),
    );

    expect(result.timedOut).toBe(true);
    expect(result.output.startsWith("[nax] test stopped early: repeated-output")).toBe(true);
    expect(result.output).toContain("pkg/a.test.ts ok");
    // The cut lands inside the x-run, so that partial line is dropped, not shown truncated.
    expect(result.output).not.toContain("xxx");
    expect(result.output.length).toBeLessThan(TIMEOUT_OUTPUT_TAIL_CHARS + 300);
  });

  test("AC-6: an agent-tool call with no policy creates no monitor and never stops heuristically", async () => {
    const monitorCalls: unknown[] = [];
    _qualityRunnerDeps.createGateStallMonitor = (options) => {
      monitorCalls.push(options);
      return createGateStallMonitor(options);
    };
    const { proc, exit } = fakeProc({ stdout: closedStream("same line\nsame line\nsame line\n") });
    exit(0);
    installSpawn(proc);

    const result = await settle(run({ origin: "agent-tool" }));

    expect(monitorCalls).toHaveLength(0);
    expect(result).toMatchObject({ success: true, exitCode: 0, timedOut: false });
    expect("stopReason" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-7 — no policy keeps today's contracts
// ---------------------------------------------------------------------------

describe("runQualityCommand — no stall policy (AC-7)", () => {
  test("AC-7: a normal exit keeps its result and carries no stopReason", async () => {
    const monitorCalls: unknown[] = [];
    _qualityRunnerDeps.createGateStallMonitor = (options) => {
      monitorCalls.push(options);
      return createGateStallMonitor(options);
    };
    const { proc, exit } = fakeProc({ stdout: closedStream("lint-clean\n"), stderr: closedStream("warn\n") });
    exit(0);
    installSpawn(proc);

    const result = await settle(run());

    expect(result).toMatchObject({ success: true, exitCode: 0, timedOut: false });
    expect(result.output).toBe("lint-clean\n\nwarn\n");
    expect("stopReason" in result).toBe(false);
    expect(monitorCalls).toHaveLength(0);
  });

  test("AC-7: a wall timeout keeps its notice and carries no stopReason", async () => {
    const { proc } = fakeProc({ stdout: closedStream("partial\n") });
    installSpawn(proc);

    const result = await settle(run({ timeoutMs: 50 }));

    expect(result).toMatchObject({ success: false, exitCode: -1, timedOut: true });
    // The harness contract is the notice alone — no partial diagnostics.
    expect(result.output).toBe("[nax] test timed out after 0.05s");
    expect("stopReason" in result).toBe(false);
    expect(kills.some((call) => call.signal === "SIGTERM")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-8 — process-group escalation survives a detector stop
// ---------------------------------------------------------------------------

describe("runQualityCommand — group escalation after a detector stop (AC-8)", () => {
  test("AC-8: SIGKILLs the remaining group without a single-pid fallback once the leader exited", async () => {
    const { proc, exit } = fakeProc({ stdout: closedStream("same line\nsame line\n") });
    // The leader obeys SIGTERM; a group member ignores it, so the group is still alive.
    onSigterm = () => {
      exit(143);
      groupAlive = true;
    };
    installSpawn(proc);

    const result = await settle(run({ stallDetection: { repeatedLineThreshold: 2 } }));

    expect(result.stopReason).toMatchObject({ kind: "repeated-output" });
    // Signalled while the leader was live, so the bare-pid fallback stays available.
    const sigterm = kills.filter((call) => call.signal === "SIGTERM");
    expect(sigterm).toEqual([{ pid: FAKE_PID, signal: "SIGTERM", singleProcessFallback: true }]);
    expect(kills.filter((call) => call.signal === "SIGKILL")).toEqual([
      { pid: FAKE_PID, signal: "SIGKILL", singleProcessFallback: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-9 / AC-10 — cleanup by the drain deadline
// ---------------------------------------------------------------------------

describe("runQualityCommand — cleanup after a detector stop (AC-9, AC-10)", () => {
  test("AC-9: clears every timer it armed by the drain deadline", async () => {
    // Real timers, so `withTimerSpy` (which patches the globals) sees them.
    _qualityRunnerDeps.setTimeout = original.setTimeout;
    _qualityRunnerDeps.clearTimeout = original.clearTimeout;
    const { proc, exit } = fakeProc({ stdout: closedStream("same line\nsame line\n") });
    onSigterm = () => exit(143);
    installSpawn(proc);

    const { result, armed, leaked } = await withTimerSpy(() => run({ stallDetection: { repeatedLineThreshold: 2 } }), {
      origin: "src/quality/runner",
    });

    expect(result.stopReason).toMatchObject({ kind: "repeated-output" });
    // The spy really saw this module's timers (the wall deadline and the grace, at least),
    // so an empty `leaked` is the code clearing them, not a filter that matched nothing.
    expect(armed.length).toBeGreaterThanOrEqual(2);
    expect(leaked).toEqual([]);
  });

  test("AC-10: cancels stalled readers best-effort by the drain deadline", async () => {
    let stdoutCancelled = false;
    let stderrCancelled = false;
    const { proc, exit } = fakeProc({
      stdout: stalledStream("same line\nsame line\n", () => {
        stdoutCancelled = true;
      }),
      stderr: stalledStream("", () => {
        stderrCancelled = true;
      }),
    });
    onSigterm = () => exit(143);
    installSpawn(proc);

    const result = await settle(run({ stallDetection: { repeatedLineThreshold: 2 } }));

    expect(result.stopReason).toMatchObject({ kind: "repeated-output" });
    expect(stdoutCancelled).toBe(true);
    expect(stderrCancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-11 / AC-12 — both orders of the terminal race
// ---------------------------------------------------------------------------

describe("runQualityCommand — terminal race orders (AC-11, AC-12)", () => {
  test("AC-11: the observed exit wins over a queued detector callback", async () => {
    const { proc, exit } = fakeProc({ stdout: closedStream("same line\nsame line\nsame line\n") });
    // The exit is already observed when the chunks arrive, so the detector cannot win.
    exit(0);
    installSpawn(proc);

    const result = await settle(run({ stallDetection: { repeatedLineThreshold: 2 } }));

    expect(result).toMatchObject({ success: true, exitCode: 0, timedOut: false });
    expect("stopReason" in result).toBe(false);
    expect(kills.some((call) => call.signal === "SIGTERM")).toBe(false);
  });

  test("AC-11: the observed exit wins over a slow inherited pipe drain", async () => {
    const { proc, exit } = fakeProc({ stdout: stalledStream("same line\nsame line\n") });
    exit(0);
    installSpawn(proc);

    const result = await settle(run({ stallDetection: { repeatedLineThreshold: 2 } }));

    expect(result).toMatchObject({ success: true, exitCode: 0, timedOut: false });
    expect("stopReason" in result).toBe(false);
    // The only signal is the pre-existing drain backstop, and it cannot use the bare pid.
    expect(kills.filter((call) => call.signal !== 0)).toEqual([
      { pid: FAKE_PID, signal: "SIGTERM", singleProcessFallback: false },
    ]);
  });

  test("AC-12: a detector callback that wins keeps the failure when exit 0 arrives later", async () => {
    const { proc, exit } = fakeProc({ stdout: closedStream("same line\nsame line\n") });
    installSpawn(proc);

    const pending = run({ stallDetection: { repeatedLineThreshold: 2 } });
    // SIGTERM proves the detector settled the latch first; exit 0 arrives after.
    await waitForCondition(() => kills.some((call) => call.signal === "SIGTERM"));
    exit(0);
    const result = await settle(pending);

    expect(result).toMatchObject({ success: false, timedOut: true, exitCode: -1 });
    expect(result.stopReason).toMatchObject({ kind: "repeated-output" });
  });
});

// ---------------------------------------------------------------------------
// AC-13 — one termination sequence
// ---------------------------------------------------------------------------

describe("runQualityCommand — single termination sequence (AC-13)", () => {
  test("AC-13: repetition, silence and wall callbacks collectively start at most one", async () => {
    const controlled = controlledStream();
    const { proc, exit } = fakeProc({ stdout: controlled.stream });
    // The leader obeys SIGTERM; a group member ignores it, so a SIGKILL is due too.
    onSigterm = () => {
      exit(143);
      groupAlive = true;
    };
    installSpawn(proc);

    const pending = run({
      timeoutMs: 60_000,
      stallDetection: { repeatedLineThreshold: 2, silenceTimeoutSeconds: 1 },
    });

    // Repetition wins first.
    controlled.push("same line\nsame line\n");
    await waitForCondition(() => kills.some((call) => call.signal === "SIGTERM"));

    // Move past the silence deadline and the SIGKILL grace, then hand the detector
    // another repetition: nothing may start a second termination sequence.
    await clock.advance(GRACE_MS + CLOCK_STEP_MS);
    expect(controlled.push("same line\nsame line\n")).toBe(true);
    await clock.advance(GRACE_MS * 4);

    const result = await settle(pending);

    expect(kills.filter((call) => call.signal === "SIGTERM")).toHaveLength(1);
    expect(kills.filter((call) => call.signal === "SIGKILL")).toHaveLength(1);
    expect(result.stopReason).toMatchObject({ kind: "repeated-output" });
  });
});

// ---------------------------------------------------------------------------
// AC-14 — a failed read is not stall evidence
// ---------------------------------------------------------------------------

describe("runQualityCommand — stream errors (AC-14)", () => {
  test("AC-14: keeps collected text and reports no stopReason", async () => {
    const { proc, exit } = fakeProc({ stdout: failingStream("collected before the failure\n", new Error("EPIPE")) });
    exit(0);
    installSpawn(proc);

    const result = await settle(run({ stallDetection: { repeatedLineThreshold: 2 } }));

    expect(result.success).toBe(true);
    expect(result.output).toContain("collected before the failure");
    expect("stopReason" in result).toBe(false);
    expect(kills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-15 — concurrent, lossless drains
// ---------------------------------------------------------------------------

describe("runQualityCommand — concurrent drains (AC-15)", () => {
  test("AC-15: reads both pipes concurrently without losing a large nonrepeating body", async () => {
    useRealExecution();

    const result = await runQualityCommand({
      commandName: "test",
      command: "printf '%200000s' '' | tr ' ' x; printf '%100000s' '' | tr ' ' y >&2",
      workdir: import.meta.dir,
      stallDetection: { repeatedLineThreshold: 100 },
    });

    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.output.length).toBeGreaterThanOrEqual(300_000);
    expect(result.output).toContain("x".repeat(1_000));
    expect(result.output).toContain("y".repeat(1_000));
    expect("stopReason" in result).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AC-16 — bounded settlement when the exit never arrives
// ---------------------------------------------------------------------------

describe("runQualityCommand — bounded settlement (AC-16)", () => {
  test("AC-16: returns the stopped result although the child's exit never settles", async () => {
    const { proc } = fakeProc({
      stdout: stalledStream("same line\nsame line\n"),
      stderr: stalledStream(""),
    });
    installSpawn(proc);

    const result = await settle(run({ stallDetection: { repeatedLineThreshold: 2 } }));

    expect(result).toMatchObject({ success: false, timedOut: true, exitCode: -1 });
    expect(result.stopReason).toMatchObject({ kind: "repeated-output", count: 2, threshold: 2 });
    // The group was still led by the child, so the fallback was allowed — and used.
    expect(kills.filter((call) => call.signal === "SIGKILL")).toEqual([
      { pid: FAKE_PID, signal: "SIGKILL", singleProcessFallback: true },
    ]);
    expect(clock.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-17 — trust before monitor and spawn
// ---------------------------------------------------------------------------

describe("runQualityCommand — trust precedes the detector (AC-17)", () => {
  useUntrustedRegistry();
  let project: string;

  beforeEach(() => {
    project = realOrRaw(makeTempDir("quality-untrusted-stall-"));
  });

  afterEach(() => {
    cleanupTempDir(project);
  });

  test("AC-17: an untrusted workdir creates no monitor and spawns no child", async () => {
    const monitorCalls: unknown[] = [];
    _qualityRunnerDeps.createGateStallMonitor = (options) => {
      monitorCalls.push(options);
      return createGateStallMonitor(options);
    };
    const stub = makeSpawn();

    await expect(
      runQualityCommand({
        commandName: "test",
        command: "echo hi",
        workdir: project,
        stallDetection: { repeatedLineThreshold: 2 },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_UNTRUSTED" });
    expect(monitorCalls).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-18 — a rejected exit promise is not stall evidence
// ---------------------------------------------------------------------------

describe("runQualityCommand — rejected exit (AC-18)", () => {
  test("AC-18: returns the existing error result without a stopReason", async () => {
    const { proc, reject } = fakeProc({ stdout: closedStream("") });
    const stub = installSpawn(proc);

    const pending = run({ stallDetection: { repeatedLineThreshold: 2 } });
    await waitForCondition(() => stub.calls.length > 0);
    reject(new Error("waitpid failed: spawn ENOENT"));
    const result = await settle(pending);

    expect(result).toMatchObject({ success: false, exitCode: -1, timedOut: false });
    expect(result.output).toContain("waitpid failed: spawn ENOENT");
    expect("stopReason" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// US-006 — the list: per-entry detector state, continuation, aggregation
// ---------------------------------------------------------------------------

/** The pid of the n-th list entry's fake child, so kills stay attributable. */
const LIST_PIDS = [7_001, 7_002, 7_003] as const;

interface ListEntry {
  /** Copies of the detector's repeat line on stdout, closing the stream. */
  repeats?: number;
  /** stdout for an entry that is not the stalled one. */
  stdout?: string;
  /** Settle this entry's exit with this code when it is spawned. */
  exitWith?: number;
}

/**
 * A spawn stub that hands each list entry its own child, in spawn order, and
 * records the policy of every monitor created. The entries without `exitWith`
 * stay live, so only a detector can end them and the test settles their exit.
 */
function listSpawn(entries: ListEntry[]): {
  stub: ReturnType<typeof makeSpawn>;
  fakes: FakeProc[];
  policies: unknown[];
} {
  const fakes: FakeProc[] = [];
  const policies: unknown[] = [];
  _qualityRunnerDeps.createGateStallMonitor = (options) => {
    policies.push(options.policy);
    return createGateStallMonitor(options);
  };
  const stub = makeSpawn(() => {
    const index = fakes.length;
    const entry = entries[index] ?? {};
    const stdout = entry.repeats === undefined ? closedStream(entry.stdout ?? "") : repeatedLinesStream(entry.repeats);
    const fake = fakeProc({ pid: LIST_PIDS[index] ?? FAKE_PID, stdout });
    fakes.push(fake);
    if (entry.exitWith !== undefined) fake.exit(entry.exitWith);
    return fake.proc;
  });
  _qualityRunnerDeps.spawn = stub.spawn;
  return { stub, fakes, policies };
}

describe("runQualityCommand with a list — fresh detector state (AC-1)", () => {
  test("AC-1: every entry counts repetitions from zero", async () => {
    const { fakes, policies } = listSpawn([{ repeats: 3 }, { repeats: 2 }]);

    const pending = run({ command: ["step-a", "step-b"], stallDetection: { repeatedLineThreshold: 3 } });
    // Entry 1 stops on its third equal line; entry 2 is spawned once it has settled.
    await advanceUntil(() => fakes.length === 2);
    fakes[1]?.exit(0);

    const result = await settle(pending);

    // One monitor per entry — nothing is created once for the whole list.
    expect(policies).toHaveLength(2);
    // Entry 2 saw the same line twice against a threshold of 3. A count carried
    // over from entry 1 would have reached 3 and stopped it instead.
    expect(result.output).toContain("=== step-a (exit -1) ===");
    expect(result.output).toContain("=== step-b (exit 0) ===");
    expect(kills.filter((call) => call.pid === LIST_PIDS[0] && call.signal === "SIGTERM")).toHaveLength(1);
    expect(kills.filter((call) => call.pid === LIST_PIDS[1])).toEqual([]);
  });

  test("AC-1: every entry arms its own silence deadline", async () => {
    const { fakes, policies } = listSpawn([{ stdout: "" }, { stdout: "progress\n" }]);

    const pending = run({ command: ["step-a", "step-b"], stallDetection: { silenceTimeoutSeconds: 2 } });
    await advanceUntil(() => fakes.length === 2);
    // Entry 1's deadline was spent seconds ago. Entry 2 then lives through the
    // first second of its own 2s window (the step `settle` takes below) — a
    // shared, already-fired deadline would have signalled it at spawn.
    fakes[1]?.exit(0);

    const result = await settle(pending);

    expect(policies).toHaveLength(2);
    expect(result.output).toContain("=== step-a (exit -1) ===");
    expect(result.output).toContain("=== step-b (exit 0) ===");
    // A shared (already-fired) deadline would have signalled entry 2 too.
    expect(kills.filter((call) => call.pid === LIST_PIDS[1])).toEqual([]);
  });
});

describe("runQualityCommand with a list — continuation (AC-2)", () => {
  test("AC-2: a stopped entry does not stop the entries after it", async () => {
    const { stub } = listSpawn([
      { repeats: 2 },
      { stdout: "step-b ok\n", exitWith: 0 },
      { stdout: "step-c ok\n", exitWith: 0 },
    ]);

    const result = await settle(
      run({ command: ["step-a", "step-b", "step-c"], stallDetection: { repeatedLineThreshold: 2 } }),
    );

    // All three ran, in order, after the first was stopped.
    expect(stub.calls.map((call) => call.cmd[2])).toEqual(["step-a", "step-b", "step-c"]);
    expect(result.output).toContain("=== step-a (exit -1) ===");
    expect(result.output).toContain("step-b ok");
    expect(result.output).toContain("step-c ok");
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    // The list carries the first detector reason, not a completed-run verdict.
    expect(result.stopReason).toEqual({ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 });
  });
});
