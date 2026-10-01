import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeLogger, makeStatusWriter, makeTempDir } from "@test/helpers";
import { _heartbeatDeps, _isHeartbeatActive, startHeartbeat, stopHeartbeat } from "@/execution/crash-heartbeat";

/** A sleep stub that resolves immediately the first N calls, then hangs forever. */
function sleepResolvesThenHangs(times: number): typeof _heartbeatDeps.sleep {
  let calls = 0;
  return () =>
    calls++ < times
      ? Promise.resolve()
      : new Promise<void>(() => {
          /* park forever — the test stops the loop before it matters */
        });
}

let origSleep: typeof _heartbeatDeps.sleep;
let origGetLogger: typeof _heartbeatDeps.getSafeLogger;

beforeEach(() => {
  stopHeartbeat();
  origSleep = _heartbeatDeps.sleep;
  origGetLogger = _heartbeatDeps.getSafeLogger;
});

afterEach(() => {
  stopHeartbeat();
  _heartbeatDeps.sleep = origSleep;
  _heartbeatDeps.getSafeLogger = origGetLogger;
});

describe("crash-heartbeat — startHeartbeat", () => {
  test("starts without throwing when given a valid status writer", () => {
    const writer = makeStatusWriter();
    expect(() =>
      startHeartbeat(
        writer,
        () => 0,
        () => 0,
      ),
    ).not.toThrow();
  });

  test("catch handler logs a warning when heartbeat loop throws (e.g. sleep interrupted)", async () => {
    // The outer .catch in startHeartbeat fires when heartbeatLoop itself rejects.
    // That happens when sleep throws — the error propagates past the inner try-catch
    // (which only wraps the tick body, not the sleep call).
    const logger = makeLogger();

    _heartbeatDeps.getSafeLogger = () => logger;

    // Make sleep throw immediately — heartbeatLoop rejects without spinning.
    _heartbeatDeps.sleep = async () => {
      throw new Error("sleep interrupted");
    };

    startHeartbeat(
      makeStatusWriter(),
      () => 0,
      () => 0,
    );

    // Give the microtask queue one macro-task tick to process the rejection.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The catch handler must log "crashed" / "stopped" as a warning, not swallow silently.
    const warnedCrashStop = logger.calls.some(
      (c) => c.level === "warn" && (c.message.includes("crashed") || c.message.includes("stopped")),
    );
    expect(warnedCrashStop).toBe(true);
  });

  // MEM-3: stopHeartbeat left one in-flight uncancellable 60s Bun.sleep running —
  // the loop checked `_heartbeatActive` only AFTER the sleep resolved, so the
  // timer kept the event loop alive up to 60s in in-process consumers. The stop
  // must abort the in-flight sleep via an AbortSignal so it settles promptly.
  test("MEM-3: stopHeartbeat aborts the in-flight sleep instead of leaving a 60s timer armed", async () => {
    let capturedSignal: AbortSignal | undefined;
    let sleepSettled = false;

    _heartbeatDeps.sleep = (_ms: number, signal?: AbortSignal) => {
      capturedSignal = signal;
      // Hang until aborted — never resolve, so the loop stays parked in the
      // sleep and no busy-spin starves the event loop.
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          sleepSettled = true;
          reject(signal.reason);
        });
      });
    };

    startHeartbeat(
      makeStatusWriter(),
      () => 0,
      () => 0,
    );
    // Let the loop reach the sleep call.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(capturedSignal).toBeDefined();

    stopHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The abort must reach the in-flight sleep (and settle it promptly —
    // no 60s wait).
    expect(capturedSignal?.aborted).toBe(true);
    expect(sleepSettled).toBe(true);
  });

  // Regression: the stop-abort rejection must not be rethrown. When
  // stopHeartbeat() nulled the controller before the loop's catch ran, every
  // normal stop logged a spurious "Heartbeat loop crashed" warning.
  test("MEM-3: a normal stop does not log a spurious 'loop crashed' warning", async () => {
    const logger = makeLogger();

    _heartbeatDeps.getSafeLogger = () => logger;

    _heartbeatDeps.sleep = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });

    startHeartbeat(
      makeStatusWriter(),
      () => 0,
      () => 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    stopHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(logger.calls.filter((c) => c.level === "warn")).toEqual([]);
  });

  // Issue #1679: startHeartbeat() must abort the superseded loop's in-flight
  // sleep when it is called again. Previously the old AbortController was
  // dropped without aborting, leaving the superseded loop parked on a live 60s
  // timer (an uncancellable Bun.sleep) for the rest of the process.
  test("startHeartbeat supersedes a running loop by aborting its in-flight sleep", async () => {
    const capturedSignals: Array<AbortSignal | undefined> = [];
    let settleCount = 0;

    _heartbeatDeps.sleep = (_ms: number, signal?: AbortSignal) => {
      capturedSignals.push(signal);
      // Hang until aborted — never resolve, so the loop stays parked in sleep.
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          settleCount++;
          reject(signal.reason);
        });
      });
    };

    startHeartbeat(
      makeStatusWriter(),
      () => 0,
      () => 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Supersede the first loop by starting a second heartbeat.
    startHeartbeat(
      makeStatusWriter(),
      () => 0,
      () => 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The first loop's signal must be aborted promptly (not left on a timer),
    // and the second loop gets its own, live controller.
    expect(capturedSignals.length).toBe(2);
    expect(capturedSignals[0]?.aborted).toBe(true);
    expect(capturedSignals[1]?.aborted).toBe(false);
    expect(settleCount).toBe(1);
  });

  test("a stale-generation loop exits at the gen check when its sleep resolves after stopHeartbeat", async () => {
    // Line-51 guard: the loop re-checks the generation counter AFTER waking, so
    // a loop whose sleep resolves normally (rather than aborting) still exits
    // instead of writing status on behalf of a superseded run. Previously this
    // branch was only ever reached incidentally, by a leaked heartbeat whose
    // real 60s sleep happened to elapse while the rest of the suite ran — which
    // stopped happening once the suite got faster than 60s.
    let releaseSleep: () => void = () => {};
    let updates = 0;

    // Ignores the abort signal on purpose: this is the resolve-normally path.
    _heartbeatDeps.sleep = () =>
      new Promise<void>((resolve) => {
        releaseSleep = resolve;
      });

    startHeartbeat(
      makeStatusWriter({
        update: async () => {
          updates++;
        },
      }),
      () => 0,
      () => 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Supersede the loop while it is parked in sleep, then let the sleep resolve.
    stopHeartbeat();
    releaseSleep();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(_isHeartbeatActive()).toBe(false);
    expect(updates).toBe(0);
  });

  test("a completed tick logs debug, appends a JSONL entry, and calls statusWriter.update", async () => {
    const dir = makeTempDir("nax-crash-heartbeat-");
    const jsonlPath = `${dir}/heartbeat.jsonl`;
    const logger = makeLogger();
    _heartbeatDeps.getSafeLogger = () => logger;
    _heartbeatDeps.sleep = sleepResolvesThenHangs(1);

    let updateCalls = 0;
    let lastCost: number | undefined;
    let lastIterations: number | undefined;

    try {
      startHeartbeat(
        makeStatusWriter({
          update: async (cost: number, iterations: number) => {
            updateCalls++;
            lastCost = cost;
            lastIterations = iterations;
          },
        }),
        () => 42,
        () => 7,
        jsonlPath,
      );

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(updateCalls).toBe(1);
      expect(lastCost).toBe(42);
      expect(lastIterations).toBe(7);
      expect(logger.calls.some((c) => c.level === "debug" && c.message === "Heartbeat")).toBe(true);

      const jsonlContent = await Bun.file(jsonlPath).text();
      const entry = JSON.parse(jsonlContent.trim());
      expect(entry.stage).toBe("heartbeat");
      expect(entry.data.pid).toBe(process.pid);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("logs a warning when statusWriter.update rejects during a tick, without crashing the loop", async () => {
    const logger = makeLogger();
    _heartbeatDeps.getSafeLogger = () => logger;
    _heartbeatDeps.sleep = sleepResolvesThenHangs(1);

    startHeartbeat(
      makeStatusWriter({
        update: async () => {
          throw new Error("disk full");
        },
      }),
      () => 0,
      () => 0,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      logger.calls.some(
        (c) => c.level === "warn" && c.message === "Failed during heartbeat" && c.data?.error === "disk full",
      ),
    ).toBe(true);
    // The tick's own catch swallowed the failure — the loop itself did not crash.
    expect(logger.calls.some((c) => c.level === "warn" && c.message.includes("crashed"))).toBe(false);
  });
});
