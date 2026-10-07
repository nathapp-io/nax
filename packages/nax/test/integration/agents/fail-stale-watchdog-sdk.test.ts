/**
 * The idle watchdog against the sdk transport's complete() (S4b spec §9):
 * AC9 and AC7 of fail-stale-watchdog.test.ts, with the backend scripted in
 * memory (scriptedOpened) instead of a mock acpx client.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeClock, makeNaxConfig, waitForCondition } from "@test/helpers";
import { hangTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
import { _acpSdkDeps, AcpSdkAgentAdapter } from "@/agents/acp-sdk";
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

const REAL_SDK = { ..._acpSdkDeps };
const REAL_WATCHDOG = { ..._idleWatchdogDeps };
let clock: ReturnType<typeof makeFakeClock>;

beforeEach(() => {
  clock = makeFakeClock();
  _idleWatchdogDeps.setTimeout = clock.setTimeout as typeof _idleWatchdogDeps.setTimeout;
  _idleWatchdogDeps.clearTimeout = clock.clearTimeout as typeof _idleWatchdogDeps.clearTimeout;
  _idleWatchdogDeps.now = clock.now;
  _acpSdkDeps.resolveRateCard = () => Promise.resolve({ rates: FALLBACK_RATES, source: "fallback-rates" });
  _acpSdkDeps.cwdExists = async () => true;
  const script = scriptedOpened([hangTurn()]);
  _acpSdkDeps.acpBackend = () => ({ kind: "acp:claude", open: async () => script.opened });
});

afterEach(() => {
  Object.assign(_acpSdkDeps, REAL_SDK);
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

describe("Idle watchdog stale cancellation (sdk transport)", () => {
  test("AC9: a hanging prompt surfaces cancelled:true before the wall-clock timeout", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const bus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const detach = attachAgentIdleWatchdog(bus, registry, makeWatchdogConfig(IDLE_TIMEOUT_MS));
    try {
      const pending = new AcpSdkAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
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
      const pending = new AcpSdkAgentAdapter("claude").complete("p", completeOptions(registry, bus, 5_000));
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
});
