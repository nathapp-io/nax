/**
 * Unit tests — isWatchdogCancelledTurn(), the pure sendPrompt classification
 * extracted from manager.ts (nax#2218).
 *
 * Pins the FULL truth table so a future refactor cannot silently flip an arm:
 * - No watchdog bookkeeping -> never fail-stale (unrelated kill).
 * - ACP shape (SessionTurnError cancelled:true) wins over a caller-signal
 *   abort — bit-for-bit base behaviour (see the asymmetry note in the module
 *   header; do not "fix" it).
 * - Native shape (plain AbortError) is stricter: a caller-signalled abort
 *   keeps the generic branch so a tearing-down run never retries.
 * - A non-abort error is never the watchdog's cancel.
 */

import { describe, expect, test } from "bun:test";
import { SessionTurnError } from "@/agents/types";
import { isWatchdogCancelledTurn, staleTurnFailure } from "@/session/watchdog-turn-classification";

const ACP_CANCELLED = () =>
  new SessionTurnError("Agent session ended with stop reason: error (externally cancelled)", true);
const NATIVE_ABORT = () => new DOMException("The operation was aborted.", "AbortError");
const PLAIN_ERROR = () => new Error("provider 500");

describe("isWatchdogCancelledTurn()", () => {
  test.each([
    [false, "acp", false, false],
    [false, "acp", true, false],
    [false, "abort", false, false],
    [false, "abort", true, false],
    [false, "plain", false, false],
    [false, "plain", true, false],
    [true, "acp", false, true],
    [true, "acp", true, true],
    [true, "abort", false, true],
    [true, "abort", true, false],
    [true, "plain", false, false],
    [true, "plain", true, false],
  ] as const)("watchdog=%s err=%s signal=%s -> %s", (watchdogFired, errShape, signalAborted, expected) => {
    const err = errShape === "acp" ? ACP_CANCELLED() : errShape === "abort" ? NATIVE_ABORT() : PLAIN_ERROR();
    expect(isWatchdogCancelledTurn({ watchdogFired, err, signalAborted })).toBe(expected);
  });

  test("a non-Error throw is never the watchdog's cancel", () => {
    expect(isWatchdogCancelledTurn({ watchdogFired: true, err: "aborted", signalAborted: false })).toBe(false);
  });
});

describe("staleTurnFailure (finish A)", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  test("watchdog cancel -> fail-stale idle-watchdog", () => {
    expect(
      staleTurnFailure({ watchdogFired: true, interrupted: false, err: abort, signalAborted: false })?.adapterFailure
        .reason,
    ).toBe("idle-watchdog");
  });
  test("interrupt -> fail-stale interrupted", () => {
    expect(
      staleTurnFailure({ watchdogFired: true, interrupted: true, err: abort, signalAborted: false })?.adapterFailure
        .reason,
    ).toBe("interrupted");
  });
  test("a caller-signalled abort is never stale", () => {
    expect(
      staleTurnFailure({ watchdogFired: true, interrupted: true, err: abort, signalAborted: true }),
    ).toBeUndefined();
  });
});

describe("isWatchdogCancelledTurn() with a finish interrupt", () => {
  test.each([
    [true, true, "plain", false, true],
    [true, true, "acp", false, true],
    [true, true, "plain", true, false],
    [true, false, "plain", false, false],
    [false, true, "plain", false, false],
  ] as const)(
    "watchdog=%s interrupted=%s err=%s signal=%s -> %s",
    (watchdogFired, interrupted, shape, signalAborted, expected) => {
      const err = shape === "acp" ? ACP_CANCELLED() : PLAIN_ERROR();
      expect(isWatchdogCancelledTurn({ watchdogFired, interrupted, err, signalAborted })).toBe(expected);
    },
  );
});
