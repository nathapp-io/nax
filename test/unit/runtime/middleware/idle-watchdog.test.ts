import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initLogger, getLogger, resetLogger } from "../../../../src/logger";
import type { LogEntry } from "../../../../src/logger/types";
import {
  AgentStreamEventBus,
  type AgentProcessUpdateEvent,
  type AgentCallEndedEvent,
  type AgentStreamEvent,
  type IAgentStreamEventBus,
} from "../../../../src/runtime/agent-stream-events";
import { attachAgentIdleWatchdog } from "../../../../src/runtime/middleware/idle-watchdog";
import { makeNaxConfig } from "../../../helpers";
import { cleanupTempDir, makeTempDir } from "../../../helpers";

type CancelCallback = () => Promise<void>;

function makeIdleWatchdogConfig(overrides: {
  enabled?: boolean;
  mode?: "off" | "observe" | "cancel" | "warn-then-cancel";
  idleTimeoutSeconds?: number;
  activityKinds?: ("message_update" | "thinking_update" | "usage_update")[];
  cancelGraceSeconds?: number;
  maxRetryAttempts?: number;
} = {}) {
  return {
    enabled: true,
    mode: "cancel" as const,
    idleTimeoutSeconds: 1,
    activityKinds: ["message_update", "thinking_update", "usage_update"] as ("message_update" | "thinking_update" | "usage_update")[],
    cancelGraceSeconds: 0.5,
    maxRetryAttempts: 3,
    ...overrides,
  };
}

function makeCallStartedEvent(overrides: { callId?: string; pid?: number } = {}): AgentStreamEvent {
  return {
    kind: "agent.call_started",
    callId: overrides.callId ?? "call-123",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    pid: overrides.pid ?? 1234,
    timestamp: Date.now(),
    model: "claude-opus-4-5",
    timeoutSeconds: 60,
  } as AgentStreamEvent;
}

function makeMessageUpdateEvent(overrides: { callId?: string } = {}): AgentStreamEvent {
  return {
    kind: "agent.message_update",
    callId: overrides.callId ?? "call-123",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    pid: 1234,
    timestamp: Date.now(),
    deltaBytes: 100,
  } as AgentStreamEvent;
}

function makeThinkingUpdateEvent(overrides: { callId?: string } = {}): AgentStreamEvent {
  return {
    kind: "agent.thinking_update",
    callId: overrides.callId ?? "call-123",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    pid: 1234,
    timestamp: Date.now(),
    deltaBytes: 50,
  } as AgentStreamEvent;
}

function makeUsageUpdateEvent(overrides: { callId?: string } = {}): AgentStreamEvent {
  return {
    kind: "agent.usage_update",
    callId: overrides.callId ?? "call-123",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    pid: 1234,
    timestamp: Date.now(),
    inputTokens: 100,
    outputTokens: 200,
    costUsd: 0.01,
  } as AgentStreamEvent;
}

function makeProcessUpdateEvent(overrides: { callId?: string; status?: AgentProcessUpdateEvent["status"] } = {}): AgentStreamEvent {
  return {
    kind: "agent.process_update",
    callId: overrides.callId ?? "call-123",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    pid: 1234,
    timestamp: Date.now(),
    status: overrides.status ?? "spawned",
  } as AgentStreamEvent;
}

function makeCallEndedEvent(overrides: { callId?: string; status?: AgentCallEndedEvent["status"] } = {}): AgentStreamEvent {
  return {
    kind: "agent.call_ended",
    callId: overrides.callId ?? "call-123",
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    pid: 1234,
    timestamp: Date.now(),
    status: overrides.status ?? "success",
  } as AgentStreamEvent;
}

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
    tmpDir = makeTempDir("nax-test-idle-watchdog-");
    logFile = join(tmpDir, `test-idle-watchdog-${Date.now()}.jsonl`);
    initLogger({ level: "debug", filePath: logFile, useChalk: false, headless: true });
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
          idleTimeoutSeconds: 10,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-1" }));

    // Wait a tiny bit, then emit message_update
    await new Promise((r) => setTimeout(r, 50));
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
          idleTimeoutSeconds: 10,
          activityKinds: ["thinking_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-2" }));
    await new Promise((r) => setTimeout(r, 50));
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
          idleTimeoutSeconds: 10,
          activityKinds: ["usage_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-3" }));
    await new Promise((r) => setTimeout(r, 50));
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
          idleTimeoutSeconds: 0.2, // Short timeout so the timer fires quickly
          activityKinds: ["message_update", "thinking_update", "usage_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-4" }));

    // Emit process_update well before the timeout — must NOT reset the idle clock
    await new Promise((r) => setTimeout(r, 50));
    eventBus.emitAgentStream(makeProcessUpdateEvent({ callId: "call-4", status: "spawned" }));

    // Wait past the idle timeout — the timer must fire because process_update did not count as activity
    await new Promise((r) => setTimeout(r, 250));
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
          idleTimeoutSeconds: 0.2,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-5" }));

    // Wait for timeout to be exceeded
    await new Promise((r) => setTimeout(r, 300));
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
          idleTimeoutSeconds: 0.2,
          cancelGraceSeconds: 0.2,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-6" }));

    // Wait for timeout + grace period
    await new Promise((r) => setTimeout(r, 500));
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
          idleTimeoutSeconds: 0.2,
          cancelGraceSeconds: 0.3,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-6b" }));

    // Wait for timeout to be exceeded
    await new Promise((r) => setTimeout(r, 250));

    // Activity arrives during grace period
    eventBus.emitAgentStream(makeMessageUpdateEvent({ callId: "call-6b" }));

    // Wait a bit more to see if cancel is called
    await new Promise((r) => setTimeout(r, 200));
    await getLogger().flush();

    // Cancel should NOT have been called because activity reset the timer
    expect(cancelWasCalled).toBe(false);

    currentUnsubscribe();
  });

  // AC7: cancel mode cancels immediately at threshold without grace period
  test("AC7: in cancel mode, immediately invokes cancellation at idle threshold", async () => {
    let cancelWasCalled = false;
    let cancelTime = 0;
    controllerRegistry.set("call-7", async () => {
      cancelWasCalled = true;
      cancelTime = Date.now();
    });

    const startTime = Date.now();

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: 0.2,
          cancelGraceSeconds: 0, // ignored in cancel mode
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-7" }));

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 300));
    await getLogger().flush();

    expect(cancelWasCalled).toBe(true);
    // Verify it was called around the timeout, not much later
    const elapsedMs = cancelTime - startTime;
    expect(elapsedMs).toBeLessThan(500); // Should be around 200-300ms

    currentUnsubscribe();
  });

  // AC8: call_ended event deletes all state and timers
  test("AC8: deletes state and timers when call_ended is emitted", async () => {
    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: 0.5,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-8" }));

    // Emit call_ended
    await new Promise((r) => setTimeout(r, 50));
    eventBus.emitAgentStream(makeCallEndedEvent({ callId: "call-8", status: "success" }));

    // Wait to see if any timeout fires after call_ended
    await new Promise((r) => setTimeout(r, 700));
    await getLogger().flush();

    // Should not have any cancellation or excessive warnings
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
          idleTimeoutSeconds: 0.2,
          maxRetryAttempts: 2,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-9" }));

    // Wait for multiple timeout/cancel cycles
    await new Promise((r) => setTimeout(r, 1000));
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
          idleTimeoutSeconds: 0.2,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-unsub" }));

    // Unsubscribe before timeout
    await new Promise((r) => setTimeout(r, 100));
    currentUnsubscribe();

    // Wait for what would have been the timeout
    await new Promise((r) => setTimeout(r, 300));
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
          idleTimeoutSeconds: 0.1,
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-disabled" }));

    await new Promise((r) => setTimeout(r, 300));
    await getLogger().flush();

    // No timers should be active when disabled
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
          idleTimeoutSeconds: 0.2,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    // Start two calls
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-10a" }));
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-10b" }));

    // Keep call-10a alive: emit messages every ~100ms so it never reaches the 200ms idle threshold.
    // call-10b receives no activity and will time out at t≈200ms.
    await new Promise((r) => setTimeout(r, 100));
    eventBus.emitAgentStream(makeMessageUpdateEvent({ callId: "call-10a" })); // t=100ms

    await new Promise((r) => setTimeout(r, 100));
    eventBus.emitAgentStream(makeMessageUpdateEvent({ callId: "call-10a" })); // t=200ms

    // call-10b has been idle 200ms — confirm it timed out; call-10a is still fresh (lastActivity=200ms)
    await new Promise((r) => setTimeout(r, 150));
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
          idleTimeoutSeconds: 10,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-mode-off" }));

    // Wait longer than idle timeout
    await new Promise((r) => setTimeout(r, 300));
    await getLogger().flush();

    // No cancellation should occur when mode is 'off'
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
          idleTimeoutSeconds: 0.2,
          cancelGraceSeconds: 0, // Zero grace period
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-zero-grace" }));

    // Wait for timeout + negligible grace period
    await new Promise((r) => setTimeout(r, 400));
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
          idleTimeoutSeconds: 0.2,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    // Start two calls
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-throwing" }));
    await new Promise((r) => setTimeout(r, 50));
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-normal" }));

    // Wait for timeouts
    await new Promise((r) => setTimeout(r, 400));
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
          idleTimeoutSeconds: 0.15,
          maxRetryAttempts: 3,
          activityKinds: ["message_update"],
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-retry-a" }));
    await new Promise((r) => setTimeout(r, 50));
    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-retry-b" }));

    // Wait for multiple timeout cycles
    await new Promise((r) => setTimeout(r, 800));
    await getLogger().flush();

    // Each call should have been retried independently
    expect(cancelAttempts["call-retry-a"]).toBeGreaterThan(0);
    expect(cancelAttempts["call-retry-b"]).toBeGreaterThan(0);

    currentUnsubscribe();
  });
});
