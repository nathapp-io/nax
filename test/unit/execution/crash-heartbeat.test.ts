import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { startHeartbeat, stopHeartbeat, _heartbeatDeps } from "../../../src/execution/crash-heartbeat";

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
    const writer = { update: async () => {} };
    expect(() => startHeartbeat(writer as any, () => 0, () => 0)).not.toThrow();
  });

  test("catch handler logs a warning when heartbeat loop throws (e.g. sleep interrupted)", async () => {
    // The outer .catch in startHeartbeat fires when heartbeatLoop itself rejects.
    // That happens when sleep throws — the error propagates past the inner try-catch
    // (which only wraps the tick body, not the sleep call).
    const warnings: string[] = [];

    _heartbeatDeps.getSafeLogger = () =>
      ({
        warn: (_stage: string, msg: string) => {
          warnings.push(msg);
        },
        debug: () => {},
        info: () => {},
        error: () => {},
      }) as any;

    // Make sleep throw immediately — heartbeatLoop rejects without spinning.
    _heartbeatDeps.sleep = async () => {
      throw new Error("sleep interrupted");
    };

    startHeartbeat({ update: async () => {} } as any, () => 0, () => 0);

    // Give the microtask queue one macro-task tick to process the rejection.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The catch handler must log "crashed" / "stopped", not swallow silently.
    expect(warnings.some((w) => w.includes("crashed") || w.includes("stopped"))).toBe(true);
  });
});
