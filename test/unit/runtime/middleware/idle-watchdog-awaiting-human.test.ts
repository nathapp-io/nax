/**
 * US-004 — the idle watchdog must not cancel a native turn that is waiting on
 * a human approval prompt.
 *
 * The native turn emits an `agent.awaiting_human` stream event for the whole
 * time a prompt is pending. The watchdog handles that kind WITHOUT a test
 * against `activityKinds` — it resets both activity clocks to the event
 * timestamp and clears an open grace window — because a human approval is
 * exactly the "waiting, not spinning" the tool-call-only timer and the grace
 * mechanism exist to accommodate.
 *
 * AC5/AC6 pin the unconditional handling (no activityKinds, grace cleared);
 * AC7/AC8 pin the tool-call-only interplay: tool_call_update alone still hits
 * the secondary timeout, and awaiting_human is what holds it open.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { FakeClock } from "@test/helpers";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { getLogger, initLogger, resetLogger } from "@/logger";
import { AgentStreamEventBus, type IAgentStreamEventBus } from "@/runtime/agent-stream-events";
import { attachAgentIdleWatchdog } from "@/runtime/middleware/idle-watchdog";
import {
  GRACE_MS,
  IDLE_TIMEOUT_MS,
  IDLE_TIMEOUT_SECONDS,
  installFakeWatchdogClock,
  makeAwaitingHumanEvent,
  makeCallStartedEvent,
  makeIdleWatchdogConfig,
  makeToolCallUpdateEvent,
  restoreWatchdogClock,
} from "./_idle-watchdog-harness";

type CancelCallback = () => Promise<void>;

let clock: FakeClock;

describe("attachAgentIdleWatchdog — awaiting-human activity (US-004)", () => {
  let tmpDir: string;
  let logFile: string;
  let eventBus: IAgentStreamEventBus;
  let controllerRegistry: Map<string, CancelCallback>;
  let currentUnsubscribe: (() => void) | undefined;

  beforeEach(() => {
    clock = installFakeWatchdogClock();
    tmpDir = makeTempDir("nax-test-idle-watchdog-awaiting-");
    logFile = join(tmpDir, `idle-watchdog-awaiting-${Date.now()}.jsonl`);
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

  test("US-004 AC5: awaiting-human keeps a cancel watchdog alive even though it is not in activityKinds", async () => {
    let cancelWasCalled = false;
    controllerRegistry.set("call-004a", async () => {
      cancelWasCalled = true;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          activityKinds: ["message_update"],
          maxRetryAttempts: 1,
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-004a" }));

    // awaiting-human arrives every 500ms for 5s. Its kind is NOT in
    // activityKinds, so only unconditional handling can hold the idle clock
    // open past the 1s threshold.
    for (let i = 0; i < 10; i++) {
      await clock.advance(500);
      eventBus.emitAgentStream(makeAwaitingHumanEvent({ callId: "call-004a" }));
    }
    // One more full idle period after the final beat must still not cancel.
    await clock.advance(IDLE_TIMEOUT_MS);
    await getLogger().flush();

    expect(cancelWasCalled).toBe(false);
  });

  test("US-004 AC6: awaiting-human arriving before the grace ends clears the pending cancel", async () => {
    let cancelWasCalled = false;
    controllerRegistry.set("call-004b", async () => {
      cancelWasCalled = true;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "warn-then-cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          activityKinds: ["message_update"],
          maxRetryAttempts: 1,
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-004b" }));

    // Reach the idle threshold: warn-then-cancel opens a grace window.
    await clock.advance(IDLE_TIMEOUT_MS);
    expect(cancelWasCalled).toBe(false);

    // awaiting-human lands inside the grace window and must abort the cancel.
    eventBus.emitAgentStream(makeAwaitingHumanEvent({ callId: "call-004b" }));

    // Step well past where the grace timer would have fired had it survived.
    await clock.advance(GRACE_MS * 2);
    await getLogger().flush();

    expect(cancelWasCalled).toBe(false);
  });

  test("US-004 AC7: 1s idle / 2s tool-only — tool_call_update + awaiting-human every 500ms never cancels", async () => {
    let cancelCalls = 0;
    controllerRegistry.set("call-004c", async () => {
      cancelCalls++;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          toolCallOnlyIdleTimeoutSeconds: 2,
          activityKinds: ["tool_call_update"],
          maxRetryAttempts: 1,
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-004c" }));

    // tool_call_update keeps the primary clock alive but ages the
    // tool-call-only clock; awaiting-human is what resets BOTH, so the 2s
    // tool-only cap must never fire across 5s of interleaved beats.
    for (let i = 0; i < 10; i++) {
      await clock.advance(500);
      eventBus.emitAgentStream(makeToolCallUpdateEvent({ callId: "call-004c" }));
      eventBus.emitAgentStream(makeAwaitingHumanEvent({ callId: "call-004c" }));
    }
    await clock.advance(IDLE_TIMEOUT_MS * 2);
    await getLogger().flush();

    expect(cancelCalls).toBe(0);
  });

  test("US-004 AC8: same watchdog, only tool_call_update every 500ms — cancel fires once the 2s tool-only timeout passes", async () => {
    let cancelCalls = 0;
    controllerRegistry.set("call-004d", async () => {
      cancelCalls++;
    });

    const config = makeNaxConfig({
      agent: {
        idleWatchdog: makeIdleWatchdogConfig({
          mode: "cancel",
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
          toolCallOnlyIdleTimeoutSeconds: 2,
          activityKinds: ["tool_call_update"],
          maxRetryAttempts: 1,
        }),
      },
    });

    currentUnsubscribe = attachAgentIdleWatchdog(eventBus, controllerRegistry, config);

    eventBus.emitAgentStream(makeCallStartedEvent({ callId: "call-004d" }));

    for (let i = 0; i < 10; i++) {
      await clock.advance(500);
      eventBus.emitAgentStream(makeToolCallUpdateEvent({ callId: "call-004d" }));
    }
    await getLogger().flush();

    // Exactly once: the tool-call-only cap fires after 2s of tool-call-only
    // activity — which is what AC7 proves awaiting-human holds open.
    expect(cancelCalls).toBe(1);
  });
});
