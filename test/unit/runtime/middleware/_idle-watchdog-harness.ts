/**
 * Shared harness for the idle-watchdog suites.
 *
 * The watchdog runs entirely on a virtual clock in tests — its tick timer,
 * grace timer, and every elapsed-time comparison are injected via
 * `_idleWatchdogDeps`.
 *
 * That matters for more than speed. These suites were stabilized twice for
 * timing races (#1002, #1008) because the old approach — sleep past a
 * threshold, then assert — is a bet that the machine schedules the test
 * promptly. Stepping the clock removes the bet: `advance(IDLE_TIMEOUT_MS)`
 * lands on the threshold exactly, every run, so thresholds can be stated in
 * readable whole seconds instead of being shaved down to keep the suite fast.
 *
 * The injection is module-scoped, not global: the logger's own timers keep
 * using the real clock, so `flush()` still behaves normally.
 *
 * Naming follows test/integration/tdd/_tdd-test-helpers.ts — the leading
 * underscore marks a local, non-collected helper module.
 */

import type { AgentCallEndedEvent, AgentProcessUpdateEvent, AgentStreamEvent } from "@/runtime";
import { _idleWatchdogDeps } from "@/runtime";
import { type FakeClock, makeFakeClock } from "@test/helpers";

/** Watchdog thresholds. Virtual time is free, so these are round and readable. */
export const IDLE_TIMEOUT_SECONDS = 1;
export const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_SECONDS * 1000;
export const GRACE_SECONDS = 0.5;
export const GRACE_MS = GRACE_SECONDS * 1000;
/** The watchdog polls at a quarter of the idle timeout. */
export const TICK_MS = IDLE_TIMEOUT_MS / 4;
/**
 * A threshold far beyond anything these tests step to. Used by cases whose
 * subject is "the event was accepted", not "the timeout fired" — the watchdog
 * must stay quiet for the whole test.
 */
export const NEVER_FIRES_SECONDS = 10;

/**
 * The clock the event factories below stamp their timestamps from. Reassigned
 * by installFakeWatchdogClock() so each test gets a fresh timeline.
 */
let activeClock: FakeClock = makeFakeClock();

interface SavedDeps {
  setTimeout: typeof _idleWatchdogDeps.setTimeout;
  clearTimeout: typeof _idleWatchdogDeps.clearTimeout;
  now: typeof _idleWatchdogDeps.now;
}
let saved: SavedDeps | undefined;

/**
 * Point the watchdog at a fresh virtual clock. Call from `beforeEach`; the
 * returned clock is what the test steps with `advance()`. Always pair with
 * restoreWatchdogClock() in `afterEach` — the deps object is module state and
 * would otherwise leak into every later test file in the same process.
 */
export function installFakeWatchdogClock(): FakeClock {
  activeClock = makeFakeClock();
  saved = {
    setTimeout: _idleWatchdogDeps.setTimeout,
    clearTimeout: _idleWatchdogDeps.clearTimeout,
    now: _idleWatchdogDeps.now,
  };
  _idleWatchdogDeps.setTimeout = activeClock.setTimeout as typeof _idleWatchdogDeps.setTimeout;
  _idleWatchdogDeps.clearTimeout = activeClock.clearTimeout as typeof _idleWatchdogDeps.clearTimeout;
  _idleWatchdogDeps.now = activeClock.now;
  return activeClock;
}

/** Restore the real timers and clock. Idempotent. */
export function restoreWatchdogClock(): void {
  if (!saved) return;
  _idleWatchdogDeps.setTimeout = saved.setTimeout;
  _idleWatchdogDeps.clearTimeout = saved.clearTimeout;
  _idleWatchdogDeps.now = saved.now;
  saved = undefined;
}

export type ActivityKind = "message_update" | "thinking_update" | "usage_update";

export function makeIdleWatchdogConfig(
  overrides: {
    enabled?: boolean;
    mode?: "off" | "observe" | "cancel" | "warn-then-cancel";
    idleTimeoutSeconds?: number;
    activityKinds?: ActivityKind[];
    cancelGraceSeconds?: number;
    maxRetryAttempts?: number;
  } = {},
) {
  return {
    enabled: true,
    mode: "cancel" as const,
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    activityKinds: ["message_update", "thinking_update", "usage_update"] as ActivityKind[],
    cancelGraceSeconds: GRACE_SECONDS,
    maxRetryAttempts: 3,
    ...overrides,
  };
}

/** Fields every agent stream event carries. Timestamped from the virtual clock. */
function baseEvent(callId: string) {
  return {
    callId,
    runId: "run-001",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    storyId: "s-42",
    stage: "run",
    pid: 1234,
    timestamp: activeClock.now(),
  };
}

export function makeCallStartedEvent(overrides: { callId?: string; pid?: number } = {}): AgentStreamEvent {
  return {
    kind: "agent.call_started",
    ...baseEvent(overrides.callId ?? "call-123"),
    pid: overrides.pid ?? 1234,
    model: "claude-opus-4-5",
    timeoutSeconds: 60,
  } as AgentStreamEvent;
}

export function makeMessageUpdateEvent(overrides: { callId?: string } = {}): AgentStreamEvent {
  return {
    kind: "agent.message_update",
    ...baseEvent(overrides.callId ?? "call-123"),
    deltaBytes: 100,
  } as AgentStreamEvent;
}

export function makeThinkingUpdateEvent(overrides: { callId?: string } = {}): AgentStreamEvent {
  return {
    kind: "agent.thinking_update",
    ...baseEvent(overrides.callId ?? "call-123"),
    deltaBytes: 50,
  } as AgentStreamEvent;
}

export function makeUsageUpdateEvent(overrides: { callId?: string } = {}): AgentStreamEvent {
  return {
    kind: "agent.usage_update",
    ...baseEvent(overrides.callId ?? "call-123"),
    inputTokens: 100,
    outputTokens: 200,
    costUsd: 0.01,
  } as AgentStreamEvent;
}

export function makeToolCallUpdateEvent(overrides: { callId?: string } = {}): AgentStreamEvent {
  return {
    kind: "agent.tool_call_update",
    ...baseEvent(overrides.callId ?? "call-123"),
    toolName: "bash",
  } as AgentStreamEvent;
}

export function makeProcessUpdateEvent(
  overrides: { callId?: string; status?: AgentProcessUpdateEvent["status"] } = {},
): AgentStreamEvent {
  return {
    kind: "agent.process_update",
    ...baseEvent(overrides.callId ?? "call-123"),
    status: overrides.status ?? "spawned",
  } as AgentStreamEvent;
}

export function makeCallEndedEvent(
  overrides: { callId?: string; status?: AgentCallEndedEvent["status"] } = {},
): AgentStreamEvent {
  return {
    kind: "agent.call_ended",
    ...baseEvent(overrides.callId ?? "call-123"),
    status: overrides.status ?? "success",
  } as AgentStreamEvent;
}
