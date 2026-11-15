/**
 * The stall detector against a real child (review-and-gate-guards US-005, AC-1).
 *
 * Split out of `runner-stall.test.ts` — that file drives the same lifecycle on a
 * virtual clock with fake children, while these two cases need a live process,
 * the real timers and the real stop lane.
 *
 * Winning the latch is not the same as returning. A detector stop enters the
 * same stop lane as a wall timeout, so the invocation still pays the post-signal
 * wait — SIGTERM, the bounded grace period, the group probe, SIGKILL — and then
 * the bounded stream drains. On Linux that wait costs the whole 5s grace period
 * for a real detached child (the behaviour `runner-drain.test.ts` records for
 * its own real-timeout case), so a stop that wins the latch at 1s still returns
 * at ~6s: CI measured 6006ms and 6008ms where macOS returns at ~1s.
 *
 * Hence two claims, each asserted for itself:
 *  - `stopReason` proves the detector beat the wall deadline — the deadline lane
 *    never sets it, so a run that lost to the deadline fails here whatever its
 *    duration;
 *  - `DETECTOR_STOP_CEILING_MS` proves the invocation then returns, covering the
 *    whole cleanup the spec allows (grace period, then both drains, concurrent)
 *    with slack for a loaded runner. It bounds a hang, not detection latency.
 */

import { describe, expect, test } from "bun:test";
import { runQualityCommand } from "@/quality/runner";

/** The wall deadline a detector has to beat, unchanged from the wall-timeout cases. */
const WALL_TIMEOUT_MS = 5_000;

/**
 * 1s of detection, the 5s SIGKILL grace period, then both stream drains (they
 * run concurrently) — with slack for a loaded runner.
 */
const DETECTOR_STOP_CEILING_MS = 15_000;

describe("runQualityCommand — a detector interrupts a live child (AC-1)", () => {
  test("AC-1: repeated output interrupts the command before its wall timeout", async () => {
    const result = await runQualityCommand({
      commandName: "test",
      command: "while true; do echo nax-stall-line; done",
      workdir: import.meta.dir,
      timeoutMs: WALL_TIMEOUT_MS,
      stallDetection: { repeatedLineThreshold: 3 },
    });

    expect(result.stopReason).toMatchObject({ kind: "repeated-output", stream: "stdout", threshold: 3 });
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.durationMs).toBeLessThan(DETECTOR_STOP_CEILING_MS);
    // Above the wall deadline plus the stop lane's cleanup, so a detector that
    // never fired fails on the assertions rather than on bun's own timeout.
  }, 45_000);

  test("AC-1: opted-in silence interrupts the command before its wall timeout", async () => {
    const result = await runQualityCommand({
      commandName: "test",
      command: "sleep 30",
      workdir: import.meta.dir,
      timeoutMs: WALL_TIMEOUT_MS,
      stallDetection: { silenceTimeoutSeconds: 1 },
    });

    expect(result.stopReason).toEqual({ kind: "silence", silenceTimeoutSeconds: 1 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(DETECTOR_STOP_CEILING_MS);
  }, 45_000);
});
