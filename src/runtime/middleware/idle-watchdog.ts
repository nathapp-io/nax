import type { NaxConfig } from "../../config";
import type { PipelineStage } from "../../config/permissions";
import { getSafeLogger } from "../../logger";
import type { AgentStreamEvent, IAgentStreamEventBus } from "../agent-stream-events";

export interface WatchdogState {
  readonly callId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: PipelineStage;
  readonly pid?: number;
  startedAt: number;
  lastActivityAt: number;
  messageUpdates: number;
  thinkingUpdates: number;
  usageUpdates: number;
}

interface WatchdogStateInternal extends WatchdogState {
  cancelAttempts: number;
  graceTimer?: ReturnType<typeof setTimeout>;
  inGracePeriod: boolean;
  warnedForCurrentIdlePeriod: boolean;
}

// setTimeout is permitted here for the recurring tick and grace period cancellation via clearTimeout
function scheduleTickIfNeeded(
  tickRef: { handle: ReturnType<typeof setTimeout> | null },
  tick: () => void,
  intervalMs: number,
): void {
  if (tickRef.handle !== null) return;
  tickRef.handle = setTimeout(tick, intervalMs);
}

function handleObserveTimeout(state: WatchdogStateInternal, idleDurationMs: number): void {
  if (state.warnedForCurrentIdlePeriod) return;
  state.warnedForCurrentIdlePeriod = true;
  getSafeLogger()?.warn("idle-watchdog", "Idle timeout exceeded", {
    storyId: state.storyId,
    key: "idle_timeout_exceeded",
    callId: state.callId,
    mode: "observe",
    idleDurationMs,
  });
}

async function handleCancelTimeout(
  state: WatchdogStateInternal,
  controllerRegistry: Map<string, () => Promise<void>>,
  maxRetryAttempts: number,
  activeStates: Map<string, WatchdogStateInternal>,
): Promise<void> {
  if (state.cancelAttempts >= maxRetryAttempts) {
    getSafeLogger()?.error("idle-watchdog", "Max retry attempts exceeded", {
      storyId: state.storyId,
      key: "max_retry_attempts_exceeded",
      callId: state.callId,
      cancelAttempts: state.cancelAttempts,
    });
    activeStates.delete(state.callId);
    return;
  }
  state.cancelAttempts++;
  // Reset synchronously to prevent double-trigger in next tick
  state.lastActivityAt = Date.now();
  getSafeLogger()?.warn("idle-watchdog", "Canceling idle call", {
    storyId: state.storyId,
    key: "idle_timeout_exceeded",
    callId: state.callId,
    mode: "cancel",
    action: "cancel",
  });
  const cancel = controllerRegistry.get(state.callId);
  if (cancel) await cancel().catch(() => {});
}

function handleWarnThenCancelTimeout(
  state: WatchdogStateInternal,
  controllerRegistry: Map<string, () => Promise<void>>,
  maxRetryAttempts: number,
  idleTimeoutMs: number,
  graceMs: number,
  activeStates: Map<string, WatchdogStateInternal>,
): void {
  if (state.cancelAttempts >= maxRetryAttempts) {
    getSafeLogger()?.error("idle-watchdog", "Max retry attempts exceeded", {
      storyId: state.storyId,
      key: "max_retry_attempts_exceeded",
      callId: state.callId,
      cancelAttempts: state.cancelAttempts,
    });
    activeStates.delete(state.callId);
    return;
  }
  getSafeLogger()?.warn("idle-watchdog", "Idle timeout exceeded, entering grace period", {
    storyId: state.storyId,
    key: "idle_timeout_exceeded",
    callId: state.callId,
    mode: "warn-then-cancel",
    gracePeriodMs: graceMs,
  });
  state.inGracePeriod = true;
  // setTimeout permitted here for grace period cancellation via clearTimeout
  state.graceTimer = setTimeout(async () => {
    if (!activeStates.has(state.callId)) return;
    state.inGracePeriod = false;
    state.graceTimer = undefined;
    if (Date.now() - state.lastActivityAt < idleTimeoutMs) return;
    state.cancelAttempts++;
    state.lastActivityAt = Date.now();
    const cancel = controllerRegistry.get(state.callId);
    if (cancel) await cancel().catch(() => {});
  }, graceMs);
}

function resetActivity(state: WatchdogStateInternal, newTimestamp: number): void {
  state.lastActivityAt = newTimestamp;
  state.warnedForCurrentIdlePeriod = false;
  if (state.inGracePeriod && state.graceTimer !== undefined) {
    clearTimeout(state.graceTimer);
    state.graceTimer = undefined;
    state.inGracePeriod = false;
  }
}

export function attachAgentIdleWatchdog(
  agentStreamEvents: IAgentStreamEventBus,
  controllerRegistry: Map<string, () => Promise<void>>,
  config: NaxConfig,
): () => void {
  const watchdogConfig = config.agent?.idleWatchdog;
  if (!watchdogConfig?.enabled || watchdogConfig.mode === "off" || watchdogConfig.mode === undefined) {
    return agentStreamEvents.onAgentStream(() => {});
  }

  const mode = watchdogConfig.mode;
  const idleTimeoutMs = (watchdogConfig.idleTimeoutSeconds ?? 30) * 1000;
  const graceMs = (watchdogConfig.cancelGraceSeconds ?? 5) * 1000;
  const maxRetryAttempts = watchdogConfig.maxRetryAttempts ?? 3;
  const activityKinds = new Set<string>(
    watchdogConfig.activityKinds ?? ["message_update", "thinking_update", "usage_update"],
  );
  // Poll at 1/4 of the idle timeout so detection latency is at most idleTimeout * 5/4
  // rather than up to 2× idleTimeout when the tick interval equals idleTimeoutMs.
  const tickIntervalMs = Math.max(1, Math.ceil(idleTimeoutMs / 4));

  const activeStates = new Map<string, WatchdogStateInternal>();
  const tickRef: { handle: ReturnType<typeof setTimeout> | null } = { handle: null };

  function tick(): void {
    tickRef.handle = null;
    const now = Date.now();
    for (const [, state] of activeStates) {
      if (state.inGracePeriod) continue;
      const idleDurationMs = now - state.lastActivityAt;
      if (idleDurationMs < idleTimeoutMs) continue;
      if (mode === "observe") handleObserveTimeout(state, idleDurationMs);
      else if (mode === "cancel") void handleCancelTimeout(state, controllerRegistry, maxRetryAttempts, activeStates);
      else if (mode === "warn-then-cancel") {
        handleWarnThenCancelTimeout(state, controllerRegistry, maxRetryAttempts, idleTimeoutMs, graceMs, activeStates);
      }
    }
    if (activeStates.size > 0) scheduleTickIfNeeded(tickRef, tick, tickIntervalMs);
  }

  const unsubscribe = agentStreamEvents.onAgentStream((event: AgentStreamEvent) => {
    switch (event.kind) {
      case "agent.call_started": {
        const now = Date.now();
        activeStates.set(event.callId, {
          callId: event.callId,
          agentName: event.agentName,
          sessionName: event.sessionName,
          storyId: event.storyId,
          stage: event.stage,
          pid: event.pid,
          startedAt: now,
          lastActivityAt: now,
          messageUpdates: 0,
          thinkingUpdates: 0,
          usageUpdates: 0,
          cancelAttempts: 0,
          inGracePeriod: false,
          warnedForCurrentIdlePeriod: false,
        });
        getSafeLogger()?.debug("idle-watchdog", "Watchdog tracking call", {
          storyId: event.storyId,
          callId: event.callId,
          mode,
          idleTimeoutMs,
        });
        scheduleTickIfNeeded(tickRef, tick, tickIntervalMs);
        break;
      }
      case "agent.message_update": {
        const state = activeStates.get(event.callId);
        if (state && activityKinds.has("message_update")) {
          state.messageUpdates++;
          resetActivity(state, event.timestamp);
        }
        break;
      }
      case "agent.thinking_update": {
        const state = activeStates.get(event.callId);
        if (state && activityKinds.has("thinking_update")) {
          state.thinkingUpdates++;
          resetActivity(state, event.timestamp);
        }
        break;
      }
      case "agent.usage_update": {
        const state = activeStates.get(event.callId);
        if (state && activityKinds.has("usage_update")) {
          state.usageUpdates++;
          resetActivity(state, event.timestamp);
        }
        break;
      }
      case "agent.process_update":
        // Do NOT reset lastActivityAt for process_update (AC4)
        break;
      case "agent.call_ended": {
        const state = activeStates.get(event.callId);
        if (state) {
          if (state.graceTimer !== undefined) clearTimeout(state.graceTimer);
          activeStates.delete(event.callId);
        }
        if (activeStates.size === 0 && tickRef.handle !== null) {
          clearTimeout(tickRef.handle);
          tickRef.handle = null;
        }
        break;
      }
    }
  });

  return () => {
    unsubscribe();
    for (const state of activeStates.values()) {
      if (state.graceTimer !== undefined) clearTimeout(state.graceTimer);
    }
    activeStates.clear();
    if (tickRef.handle !== null) {
      clearTimeout(tickRef.handle);
      tickRef.handle = null;
    }
  };
}
