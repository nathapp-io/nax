import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLogger, makeStatusWriter } from "@test/helpers";
import { _heartbeatDeps, _isHeartbeatActive, startHeartbeat, stopHeartbeat } from "@/execution/crash-heartbeat";

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
});
