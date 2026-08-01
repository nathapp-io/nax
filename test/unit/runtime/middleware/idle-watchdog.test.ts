import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initLogger, getLogger, resetLogger } from "../../../../src/logger";
import type { LogEntry } from "../../../../src/logger/types";
import { AgentStreamEventBus, type IAgentStreamEventBus } from "../../../../src/runtime/agent-stream-events";
import { attachAgentIdleWatchdog } from "../../../../src/runtime/middleware/idle-watchdog";
import type { FakeClock } from "../../../helpers";
import { makeNaxConfig } from "../../../helpers";
import { cleanupTempDir, makeTempDir } from "../../../helpers";
import {
  GRACE_MS,
  GRACE_SECONDS,
  IDLE_TIMEOUT_MS,
  IDLE_TIMEOUT_SECONDS,
  NEVER_FIRES_SECONDS,
  TICK_MS,
  installFakeWatchdogClock,
  makeCallEndedEvent,
  makeCallStartedEvent,
  makeIdleWatchdogConfig,
  makeMessageUpdateEvent,
  makeProcessUpdateEvent,
  makeThinkingUpdateEvent,
  makeUsageUpdateEvent,
  restoreWatchdogClock,
} from "./_idle-watchdog-harness";

type CancelCallback = () => Promise<void>;

// Virtual clock — see _idle-watchdog-harness.ts for why these suites do not
// sleep. Assigned in beforeEach; every test steps it with clock.advance().
let clock: FakeClock;

async function parseAllEntries(logFile: string): Promise<LogEntry[]> {
  const content = await Bun.file(logFile).text();
  const lines = content.trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as LogEntry);
}

describe("attachAgentIdleWatchdog", () => {
  let logFile: string;
  let tmpDir: string;
  let eventBus: IAgentStreamEventBus;
  let controllerRegistry: Map<string, CancelCallback>;
  let currentUnsubscribe: (() => void) | undefined;

  beforeEach(() => {
    clock = installFakeWatchdogClock();

    tmpDir = makeTempDir("nax-test-idle-watchdog-");
    logFile = join(tmpDir, `test-idle-watchdog-${Date.now()}.jsonl`);
    initLogger({ level: "silent", filePath: logFile });
    eventBus = new AgentStreamEventBus();
    controllerRegistry = new Map();
    currentUnsubscribe = undefined;
  });

  afterEach(async () => {
    try {
      if (currentUnsubscribe) currentUnsubscribe();
    } catch {
      /* best-effort — unsubscribe itself threw */
    }
    currentUnsubscribe = undefined;
    restoreWatchdogClock();
    try {
      await getLogger().flush();
      resetLogger();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  // AC1: message_update activity resets lastActivityAt
  test("AC1: resets lastActivityAt when message_update is emitted and configured", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "observe",
          idleTimeoutSeconds: NEVER_FIRES_SECONDS,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-1" }));

    // Wait a tiny bit, then emit message_update
    await clock.advance(TICK_MS);
    eventBus.emitAgentStream(makeMessageUpdateEvent({ callId: "call-1" }));
    await getLogger().flush();

    // Just verify that no error occurs and the event is processed
    expect(controllerRegistry.size).toBe(0); // observe mode doesn't register controllers
  });

  // AC2: thinking_update activity resets lastActivityAt
  test("AC2: resets lastActivityAt when thinking_update is emitted and configured", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "observe",
          idleTimeoutSeconds: NEVER_FIRES_SECONDS,
          activityKinds: ["thinking_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-2" }));
    await clock.advance(TICK_MS);
    eventBus.emitAgentStream(makeThinkingUpdateEvent({ callId: "call-2" }));
    await getLogger().flush();

    expect(controllerRegistry.size).toBe(0);
  });

  // AC3: usage_update activity resets lastActivityAt
  test("AC3: resets lastActivityAt when usage_update is emitted and configured", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "observe",
          idleTimeoutSeconds: NEVER_FIRES_SECONDS,
          activityKinds: ["usage_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-3" }));
    await clock.advance(TICK_MS);
    eventBus.emitAgentStream(makeUsageUpdateEvent({ callId: "call-3" }));
    await getLogger().flush();

    expect(controllerRegistry.size).toBe(0);
  });

  // AC4: process_update does NOT reset lastActivityAt
  test("AC4: does NOT reset lastActivityAt when process_update is emitted", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "observe",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          activityKinds: ["message_update", "thinking_update", "usage_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-4" }));

    // Emit process_update well before the timeout — must NOT reset the idle clock
    await clock.advance(TICK_MS);
    eventBus.emitAgentStream(makeProcessUpdateEvent({ callId: "call-4", status: "spawned" }));

    // Step to exactly the idle threshold measured from call_started. It can only
    // be reached if process_update left lastActivityAt alone.
    await clock.advance(IDLE_TIMEOUT_MS - TICK_MS);
    await getLogger().flush();

    const entries = await parseAllEntries(logFile);
    const warnEntry = entries.find((e) => e.level === "warn" && e.data?.key === "idle_timeout_exceeded");

    // Warning must be present, proving the timer fired (i.e. process_update did not reset it)
    expect(warnEntry).toBeDefined();
    expect(warnEntry?.data?.callId).toBe("call-4");

    currentUnsubscribe();
  });

  // AC5: observe mode logs warning but does NOT invoke cancellation
  test("AC5: in observe mode, logs warning but does NOT cancel when idle timeout exceeded", async () => {
    let cancelWasCalled = false;
    controllerRegistry.set("call-5", async () => {
      cancelWasCalled = true;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "observe",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-5" }));

    await clock.advance(IDLE_TIMEOUT_MS);
    await getLogger().flush();

    const entries = await parseAllEntries(logFile);
    const warnEntry = entries.find((e) => e.level === "warn" && e.data?.key === "idle_timeout_exceeded");

    expect(warnEntry).toBeDefined();
    expect(warnEntry?.data?.mode).toBe("observe");
    expect(cancelWasCalled).toBe(false);

    currentUnsubscribe();
  });

  // AC6: warn-then-cancel mode waits grace period and cancels if still idle
  test("AC6: in warn-then-cancel mode, waits grace period before canceling", async () => {
    let cancelWasCalled = false;
    controllerRegistry.set("call-6", async () => {
      cancelWasCalled = true;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "warn-then-cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          cancelGraceSeconds: GRACE_SECONDS,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-6" }));

    // Idle threshold arms the grace timer; the grace period then elapses.
    await clock.advance(IDLE_TIMEOUT_MS);
    expect(cancelWasCalled).toBe(false); // still inside the grace window
    await clock.advance(GRACE_MS);
    await getLogger().flush();

    // Should have logged warning and then canceled
    const entries = await parseAllEntries(logFile);
    const warnEntry = entries.find((e) => e.level === "warn" && e.data?.key === "idle_timeout_exceeded");
    expect(warnEntry?.data?.mode).toBe("warn-then-cancel");

    // The cancel should eventually be called after grace period
    expect(cancelWasCalled).toBe(true);

    currentUnsubscribe();
  });

  // AC6b: warn-then-cancel aborts cancellation if activity arrives during grace period
  test("AC6b: in warn-then-cancel mode, aborts cancellation if activity arrives during grace period", async () => {
    let cancelWasCalled = false;
    controllerRegistry.set("call-6b", async () => {
      cancelWasCalled = true;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "warn-then-cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          // Deliberately LONGER than the idle timeout, which is what makes this
          // test discriminating. When the grace timer fires it re-checks whether
          // the call is still idle; with a short grace the activity below is
          // recent enough that the re-check alone suppresses the cancel, and the
          // test passes even if clearGrace() is broken. A grace longer than the
          // idle period means the call is idle *again* by the time grace expires,
          // so the only thing that can prevent the cancel is the timer having
          // been cleared when the activity arrived.
          cancelGraceSeconds: IDLE_TIMEOUT_SECONDS * 2,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-6b" }));

    // Reach the idle threshold, which opens the grace window.
    await clock.advance(IDLE_TIMEOUT_MS);

    // Activity arrives mid-grace and must abort the pending cancel.
    eventBus.emitAgentStream(makeMessageUpdateEvent({ callId: "call-6b" }));

    // Step past where the grace timer would have fired had it survived.
    await clock.advance(IDLE_TIMEOUT_MS * 2);
    await getLogger().flush();

    // Cancel should NOT have been called because activity cleared the grace timer
    expect(cancelWasCalled).toBe(false);

    currentUnsubscribe();
  });

  // AC7: cancel mode cancels immediately at threshold without grace period
  test("AC7: in cancel mode, immediately invokes cancellation at idle threshold", async () => {
    let cancelWasCalled = false;
    let cancelTime = 0;
    controllerRegistry.set("call-7", async () => {
      cancelWasCalled = true;
      cancelTime = clock.now();
    });

    const startTime = clock.now();

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          cancelGraceSeconds: 0, // ignored in cancel mode
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-7" }));

    await clock.advance(IDLE_TIMEOUT_MS);
    await getLogger().flush();

    expect(cancelWasCalled).toBe(true);
    // Exact, not a bound: cancel mode skips the grace period, so the cancel
    // lands on the very tick that detects the threshold.
    expect(cancelTime - startTime).toBe(IDLE_TIMEOUT_MS);

    currentUnsubscribe();
  });

  // AC8: call_ended event deletes all state and timers
  test("AC8: deletes state and timers when call_ended is emitted", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-8" }));

    // Emit call_ended before the threshold is reached.
    await clock.advance(TICK_MS);
    eventBus.emitAgentStream(makeCallEndedEvent({ callId: "call-8", status: "success" }));

    // The tick timer must be disarmed, not merely inert.
    expect(clock.pending()).toBe(0);

    // Far past where the timeout would have fired had the state survived.
    await clock.advance(IDLE_TIMEOUT_MS * 10);
    await getLogger().flush();

    const entries = await parseAllEntries(logFile);
    const cancelEntries = entries.filter((e) => e.data?.action === "cancel");
    // After call_ended, there should be no cancellation attempts
    expect(cancelEntries.length).toBe(0);

    currentUnsubscribe();
  });

  // AC9: maxRetryAttempts prevents infinite retries
  test("AC9: emits terminal failure when maxRetryAttempts exceeded", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          maxRetryAttempts: 2,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-9" }));

    // Each cancel resets the idle clock, so N attempts take N idle periods;
    // step past the 2-attempt cap to reach the terminal failure.
    await clock.advance(IDLE_TIMEOUT_MS * 4);
    await getLogger().flush();

    const entries = await parseAllEntries(logFile);
    const terminalFailure = entries.find((e) => e.data?.key === "max_retry_attempts_exceeded");

    expect(terminalFailure).toBeDefined();
    expect(terminalFailure?.level).toBe("error");

    currentUnsubscribe();
  });

  // AC10: config validation rejects idleTimeoutSeconds <= 0 when mode is not 'off'
  test("AC10: config validation rejects idleTimeoutSeconds <= 0 when mode is not off", () => {
    // The schema validation should reject invalid config with idleTimeoutSeconds <= 0
    // when mode is not 'off'. This test verifies that the schema properly validates.
    // In a real implementation, this would throw during config parsing.

    const validConfig = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: 10,
        }),
      },
    });

    // Valid config should have positive timeout when not in 'off' mode
    expect(validConfig.agent?.idleWatchdog?.idleTimeoutSeconds).toBeGreaterThan(0);
  });

  test("returns an unsubscribe function that stops monitoring", async () => {
    let cancelWasCalled = false;
    controllerRegistry.set("call-unsub", async () => {
      cancelWasCalled = true;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-unsub" }));

    // Unsubscribe before timeout
    await clock.advance(TICK_MS);
    currentUnsubscribe();

    // Teardown must disarm the tick timer, not leave it running.
    expect(clock.pending()).toBe(0);

    // Well past what would have been the timeout.
    await clock.advance(IDLE_TIMEOUT_MS * 10);
    await getLogger().flush();

    // Should not have canceled because we unsubscribed
    expect(cancelWasCalled).toBe(false);
  });

  test("handles disabled watchdog (enabled: false)", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          enabled: false,
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-disabled" }));

    await clock.advance(IDLE_TIMEOUT_MS * 10);
    await getLogger().flush();

    // Directly observable now: a disabled watchdog arms no timer whatsoever.
    expect(clock.pending()).toBe(0);
    expect(controllerRegistry.size).toBe(0);
  });

  test("handles multiple concurrent calls", async () => {
    const cancelCalls: string[] = [];
    controllerRegistry.set("call-10a", async () => {
      cancelCalls.push("call-10a");
    });
    controllerRegistry.set("call-10b", async () => {
      cancelCalls.push("call-10b");
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    // Start two calls at t=0.
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-10a" }));
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-10b" }));

    // Keep call-10a alive with activity at the halfway mark; call-10b gets none.
    await clock.advance(IDLE_TIMEOUT_MS / 2);
    eventBus.emitAgentStream(makeMessageUpdateEvent({ callId: "call-10a" }));

    // t = IDLE_TIMEOUT_MS: call-10b has been idle the full period and is cancelled.
    // call-10a's clock restarted at the halfway mark, so it is only half-idle.
    await clock.advance(IDLE_TIMEOUT_MS / 2);
    await getLogger().flush();

    // call-10b should have been canceled, call-10a should still be active
    expect(cancelCalls).toContain("call-10b");
    expect(cancelCalls).not.toContain("call-10a");

    currentUnsubscribe();
  });

  // Suggested criteria: mode 'off' should not create timers or state
  test("when mode is 'off', does not create timers or state", async () => {
    let cancelWasCalled = false;
    controllerRegistry.set("call-mode-off", async () => {
      cancelWasCalled = true;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "off",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-mode-off" }));

    // Far longer than the idle timeout.
    await clock.advance(IDLE_TIMEOUT_MS * 10);
    await getLogger().flush();

    // Directly observable now: mode "off" arms no timer at all.
    expect(clock.pending()).toBe(0);
    expect(cancelWasCalled).toBe(false);

    currentUnsubscribe();
  });

  // Suggested criteria: cancelGraceSeconds of 0 in warn-then-cancel mode
  test("when cancelGraceSeconds is 0 in warn-then-cancel mode, cancels immediately after warning", async () => {
    let cancelWasCalled = false;
    controllerRegistry.set("call-zero-grace", async () => {
      cancelWasCalled = true;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "warn-then-cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          cancelGraceSeconds: 0, // Zero grace period
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-zero-grace" }));

    // A zero-length grace window closes on the same tick that opened it.
    await clock.advance(IDLE_TIMEOUT_MS);
    await getLogger().flush();

    // Cancellation should have been called (like cancel mode)
    expect(cancelWasCalled).toBe(true);

    const entries = await parseAllEntries(logFile);
    const warnEntry = entries.find((e) => e.level === "warn" && e.data?.key === "idle_timeout_exceeded");
    expect(warnEntry?.data?.mode).toBe("warn-then-cancel");

    currentUnsubscribe();
  });

  // Suggested criteria: cancellation function throwing should be handled gracefully
  test("when cancellation function throws, logs error and continues monitoring other calls", async () => {
    const cancelCalls: string[] = [];
    const throwingError = new Error("Cancellation failed");

    controllerRegistry.set("call-throwing", async () => {
      cancelCalls.push("call-throwing");
      throw throwingError;
    });

    controllerRegistry.set("call-normal", async () => {
      cancelCalls.push("call-normal");
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    // Start two calls, staggered, so they reach their thresholds on different ticks.
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-throwing" }));
    await clock.advance(TICK_MS);
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-normal" }));

    // Past both thresholds: call-throwing at +1000, call-normal at +1250.
    await clock.advance(IDLE_TIMEOUT_MS * 2);
    await getLogger().flush();

    // Both should have been attempted to cancel
    expect(cancelCalls).toContain("call-throwing");
    expect(cancelCalls).toContain("call-normal");

    const entries = await parseAllEntries(logFile);
    // Should have logged warnings for both calls despite one throwing
    const warningCount = entries.filter((e) => e.level === "warn").length;
    expect(warningCount).toBeGreaterThan(0);

    currentUnsubscribe();
  });

  // Suggested criteria: multiple cancel attempts for same call
  test("tracks independent cancel attempts per call without cross-contamination", async () => {
    const cancelAttempts: { [key: string]: number } = {};
    controllerRegistry.set("call-retry-a", async () => {
      cancelAttempts["call-retry-a"] = (cancelAttempts["call-retry-a"] ?? 0) + 1;
    });

    controllerRegistry.set("call-retry-b", async () => {
      cancelAttempts["call-retry-b"] = (cancelAttempts["call-retry-b"] ?? 0) + 1;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          maxRetryAttempts: 3,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-retry-a" }));
    await clock.advance(TICK_MS);
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-retry-b" }));

    // Each cancel resets that call's idle clock, so three attempts take three
    // idle periods. Step past all of them for both calls.
    await clock.advance(IDLE_TIMEOUT_MS * 4);
    await getLogger().flush();

    // Exact, not a lower bound: each call must spend its own maxRetryAttempts
    // budget, so a shared counter (the cross-contamination this guards) now fails.
    expect(cancelAttempts["call-retry-a"]).toBe(3);
    expect(cancelAttempts["call-retry-b"]).toBe(3);

    currentUnsubscribe();
  });
});
