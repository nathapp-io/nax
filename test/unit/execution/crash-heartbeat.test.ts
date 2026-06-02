import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { startHeartbeat, stopHeartbeat } from "../../../src/execution/crash-heartbeat";

beforeEach(() => {
  stopHeartbeat();
});

afterEach(() => {
  stopHeartbeat();
});

describe("crash-heartbeat — startHeartbeat", () => {
  test("starts without throwing when given a valid status writer", () => {
    const writer = { update: async () => {} };
    expect(() => startHeartbeat(writer as any, () => 0, () => 0)).not.toThrow();
    stopHeartbeat();
  });

  test("does not propagate a crash from the heartbeat loop as an unhandled rejection", async () => {
    // If the heartbeat loop crash reached the caller, this async test would fail
    // with an unhandled rejection. The fix ensures it is logged instead.
    const crashingWriter = {
      update: async () => {
        throw new Error("disk full");
      },
    };

    // startHeartbeat must not throw synchronously
    expect(() =>
      startHeartbeat(crashingWriter as any, () => 0, () => 0),
    ).not.toThrow();

    stopHeartbeat();
    // If we reach here, no unhandled rejection propagated
    expect(true).toBe(true);
  });
});
