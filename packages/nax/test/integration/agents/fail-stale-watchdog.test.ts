/**
 * The idle watchdog against the ACP adapter's complete() (S4b spec §9), with
 * the backend scripted in memory (scriptedOpened).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TurnEvent } from "@nathapp/nax-agent";
import { makeFakeClock, makeNaxConfig, waitForCondition } from "@test/helpers";
import { hangTurn, type ScriptedTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
import { _acpDeps, AcpAgentAdapter } from "@/agents/acp";
import { FALLBACK_RATES } from "@/agents/cost";
import { _idleWatchdogDeps, AgentStreamEventBus, attachAgentIdleWatchdog } from "@/runtime";

function makeWatchdogConfig(
  idleTimeoutMs: number,
  activityKinds: ("message_update" | "thinking_update" | "usage_update" | "tool_call_update")[] = [
    "message_update",
    "thinking_update",
    "usage_update",
    "tool_call_update",
  ],
  toolCallOnlyIdleTimeoutMs = idleTimeoutMs * 2,
) {
  return makeNaxConfig({
    agent: {
      idleWatchdog: {
        enabled: true,
        mode: "cancel",
        idleTimeoutSeconds: idleTimeoutMs / 1000,
        toolCallOnlyIdleTimeoutSeconds: toolCallOnlyIdleTimeoutMs / 1000,
        activityKinds,
        cancelGraceSeconds: 0,
        maxRetryAttempts: 1,
      },
    },
  });
}

const REAL_SDK = { ..._acpDeps };
const REAL_WATCHDOG = { ..._idleWatchdogDeps };
let clock: ReturnType<typeof makeFakeClock>;

beforeEach(() => {
  clock = makeFakeClock();
  _idleWatchdogDeps.setTimeout = clock.setTimeout as typeof _idleWatchdogDeps.setTimeout;
  _idleWatchdogDeps.clearTimeout = clock.clearTimeout as typeof _idleWatchdogDeps.clearTimeout;
  _idleWatchdogDeps.now = clock.now;
  _acpDeps.resolveRateCard = () => Promise.resolve({ rates: FALLBACK_RATES, source: "fallback-rates" });
  _acpDeps.cwdExists = async () => true;
  const script = scriptedOpened([hangTurn()]);
  _acpDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => script.opened });
});

afterEach(() => {
  Object.assign(_acpDeps, REAL_SDK);
  Object.assign(_idleWatchdogDeps, REAL_WATCHDOG);
});

function completeOptions(registry: Map<string, () => Promise<void>>, bus: AgentStreamEventBus, timeoutMs: number) {
  return {
    resolvedPermissions: { mode: "approve-reads" as const, bashApproval: "raw" as const },
    modelDef: { provider: "anthropic" as const, model: "haiku" },
    workdir: "/tmp/test",
    timeoutMs,
    storyId: "us-test",
    onActiveCall: (callId: string, cancel: () => Promise<void>) => {
      registry.set(callId, cancel);
    },
    onStreamActivity: bus.emitAgentStream.bind(bus),
  };
}

/**
 * A backend prompt that emits `event` every `intervalMs` on the fake clock and
 * resolves "done" after `durationMs`; aborts like hangTurn if cancelled first.
 */
function activeTurn(event: TurnEvent, intervalMs: number, durationMs: number): ScriptedTurn {
  return (_prompt, opts) =>
    new Promise((resolve, reject) => {
      let elapsed = 0;
      const tick = (): void => {
        if (opts.signal?.aborted) {
          const reason: unknown = opts.signal.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
          return;
        }
        elapsed += intervalMs;
        opts.onTurnEvent?.(event);
        if (elapsed >= durationMs) {
          resolve({
            output: "done",
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
            estimatedCostUsd: 0,
            costSource: "reported",
            internalRoundTrips: 1,
          });
          return;
        }
        clock.setTimeout(tick, intervalMs);
      };
      clock.setTimeout(tick, intervalMs);
    });
}

function scriptBackend(turn: ScriptedTurn): void {
  const script = scriptedOpened([turn]);
  _acpDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => script.opened });
}

describe("Idle watchdog stale cancellation (ACP)", () => {
  test("AC9: a hanging prompt surfaces cancelled:true before the wall-clock timeout", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(bus, registry, makeWatchdogConfig(IDLE_TIMEOUT_MS));
    try {
      const pending = new AcpAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      // createSession does real async work before call_started; wait until the call is registered.
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(IDLE_TIMEOUT_MS * 2);
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(result.adapterFailure).toBeUndefined();
    } finally {
      detach();
    }
  });

  test("AC7: the watchdog cancel is not reported as a wall-clock timeout", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(bus, registry, makeWatchdogConfig(IDLE_TIMEOUT_MS));
    try {
      const pending = new AcpAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      // createSession does real async work before call_started; wait until the call is registered.
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(IDLE_TIMEOUT_MS * 2);
      const outcome = await pending.then(
        (result) => ({ kind: "result" as const, result }),
        (err: unknown) => ({ kind: "error" as const, err }),
      );
      expect(outcome.kind).toBe("result");
    } finally {
      detach();
    }
  });

  test("AC10: periodic thinking activity keeps the watchdog from firing", async () => {
    const IDLE_TIMEOUT_MS = 200;
    scriptBackend(activeTurn({ type: "thinking_delta", round: 1, text: "..." }, 50, 250));
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(bus, registry, makeWatchdogConfig(IDLE_TIMEOUT_MS));
    try {
      const pending = new AcpAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(300);
      const result = await pending;
      expect(result.cancelled).toBeFalsy();
      expect(result.output).toBe("done");
    } finally {
      detach();
    }
  });

  test("AC11: periodic usage-only activity keeps the watchdog from firing", async () => {
    const IDLE_TIMEOUT_MS = 200;
    scriptBackend(
      activeTurn(
        { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, costSource: "reported" },
        50,
        250,
      ),
    );
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(
      bus,
      registry,
      makeWatchdogConfig(IDLE_TIMEOUT_MS, ["message_update", "thinking_update", "usage_update"]),
    );
    try {
      const pending = new AcpAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(300);
      const result = await pending;
      expect(result.cancelled).toBeFalsy();
      expect(result.output).toBe("done");
    } finally {
      detach();
    }
  });

  test("tool-call-only activity is not cancelled before the secondary cap", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const TOOL_CALL_ONLY_TIMEOUT_MS = 220;
    // tool_call first so the bridge knows the name; tool_progress heartbeats follow.
    let first = true;
    const turn: ScriptedTurn = (prompt, opts) => {
      if (first) {
        first = false;
        opts.onTurnEvent?.({ type: "tool_call", callId: "c1", name: "Bash", input: {} });
      }
      return activeTurn({ type: "tool_progress", callId: "c1" }, 30, 170)(prompt, opts);
    };
    scriptBackend(turn);
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(
      bus,
      registry,
      makeWatchdogConfig(
        IDLE_TIMEOUT_MS,
        ["message_update", "thinking_update", "usage_update", "tool_call_update"],
        TOOL_CALL_ONLY_TIMEOUT_MS,
      ),
    );
    try {
      const pending = new AcpAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(200);
      const result = await pending;
      expect(result.cancelled).toBeFalsy();
      expect(result.output).toBe("done");
    } finally {
      detach();
    }
  });

  test("the idle timeout follows config.agent.idleWatchdog.idleTimeoutSeconds", async () => {
    const SHORT_IDLE_TIMEOUT_MS = 60;
    const WALL_CLOCK_TIMEOUT_MS = 2_000;
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(bus, registry, makeWatchdogConfig(SHORT_IDLE_TIMEOUT_MS));
    try {
      const pending = new AcpAgentAdapter("claude").complete(
        "p",
        completeOptions(registry, bus, WALL_CLOCK_TIMEOUT_MS),
      );
      await waitForCondition(() => registry.size > 0);
      await clock.advance(0);
      await clock.advance(SHORT_IDLE_TIMEOUT_MS * 2);
      const result = await pending;
      // Only the configured 60ms idle timeout can cancel by t=120ms: the virtual
      // clock never reaches the wall-clock budget, so cancelled proves the config.
      expect(result.cancelled).toBe(true);
    } finally {
      detach();
    }
  });
});
