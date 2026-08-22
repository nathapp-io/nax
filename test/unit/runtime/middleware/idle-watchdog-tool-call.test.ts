import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getLogger, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
import { AgentStreamEventBus, attachAgentIdleWatchdog } from "@/runtime";
import type { FakeClock } from "@test/helpers";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import {
  installFakeWatchdogClock,
  makeCallStartedEvent,
  makeThinkingUpdateEvent,
  makeToolCallUpdateEvent,
  restoreWatchdogClock,
} from "./_idle-watchdog-harness";

// Virtual clock — see _idle-watchdog-harness.ts. These cases turn on how
// tool-call activity interacts with two different timeouts, so the exact
// interleaving of events and ticks is the thing under test; stepping the clock
// makes that interleaving reproducible instead of scheduler-dependent.
let clock: FakeClock;

/**
 * Emit a tool_call_update every `intervalMs` of virtual time for `durationMs`,
 * then one more so the final activity timestamp is fresh for the assertions
 * that run immediately after.
 */
async function emitToolCallUpdatesForDuration(
  eventBus: AgentStreamEventBus,
  durationMs: number,
  intervalMs = 25,
): Promise<void> {
  for (let elapsed = 0; elapsed < durationMs; elapsed += intervalMs) {
    eventBus.emitAgentStream(makeToolCallUpdateEvent());
    await clock.advance(intervalMs);
  }
  eventBus.emitAgentStream(makeToolCallUpdateEvent());
}

type ActivityKind = "message_update" | "thinking_update" | "usage_update" | "tool_call_update";

function makeWatchdogConfig(
  overrides: {
    mode?: "off" | "observe" | "warn-then-cancel" | "cancel";
    idleTimeoutSeconds?: number;
    toolCallOnlyIdleTimeoutSeconds?: number;
    activityKinds?: ActivityKind[];
  } = {},
) {
  return makeNaxConfig({
    agent: {
      idleWatchdog: {
        enabled: true,
        mode: "cancel",
        idleTimeoutSeconds: 0.1,
        toolCallOnlyIdleTimeoutSeconds: 0.12,
        activityKinds: ["message_update", "thinking_update", "usage_update", "tool_call_update"],
        cancelGraceSeconds: 0,
        maxRetryAttempts: 1,
        ...overrides,
      },
    },
  });
}

/** Registry with a single counting cancel callback for "call-123". */
function makeCountingRegistry(): { registry: Map<string, () => Promise<void>>; count: () => number } {
  let cancelCount = 0;
  const registry = new Map<string, () => Promise<void>>([
    [
      "call-123",
      async () => {
        cancelCount++;
      },
    ],
  ]);
  return { registry, count: () => cancelCount };
}

async function parseAllEntries(logFile: string): Promise<LogEntry[]> {
  const content = await Bun.file(logFile).text();
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

describe("attachAgentIdleWatchdog — tool-call activity", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    clock = installFakeWatchdogClock();
    tmpDir = makeTempDir("nax-test-idle-watchdog-tool-");
    logFile = join(tmpDir, `idle-watchdog-tool-${Date.now()}.jsonl`);
    initLogger({ level: "silent", filePath: logFile });
  });

  afterEach(async () => {
    restoreWatchdogClock();
    await getLogger().flush();
    resetLogger();
    cleanupTempDir(tmpDir);
  });

  test("tool-call updates keep the primary idle timeout alive until the secondary cap is reached", async () => {
    const eventBus = new AgentStreamEventBus();
    const { registry, count } = makeCountingRegistry();
    const detach = attachAgentIdleWatchdog(
      eventBus,
      registry,
      makeWatchdogConfig({ idleTimeoutSeconds: 0.25, toolCallOnlyIdleTimeoutSeconds: 0.7 }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      await emitToolCallUpdatesForDuration(eventBus, 220, 30);

      expect(count()).toBe(0);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "idle_timeout_exceeded")).toBe(false);
    } finally {
      detach();
    }
  });

  test("tool-call-only activity hits the secondary timeout with a distinct log key", async () => {
    const eventBus = new AgentStreamEventBus();
    const { registry, count } = makeCountingRegistry();
    const detach = attachAgentIdleWatchdog(eventBus, registry, makeWatchdogConfig());

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      await emitToolCallUpdatesForDuration(eventBus, 220, 25);

      // No polling needed: the cancel runs inside advance(), and the fake clock
      // drains microtasks before returning.
      expect(count()).toBe(1);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "tool_call_only_idle_timeout_exceeded")).toBe(true);
      expect(entries.some((entry) => entry.data?.key === "idle_timeout_exceeded")).toBe(false);
    } finally {
      detach();
    }
  });

  test("non-tool activity resets the secondary timer", async () => {
    const eventBus = new AgentStreamEventBus();
    const { registry, count } = makeCountingRegistry();
    const detach = attachAgentIdleWatchdog(
      eventBus,
      registry,
      makeWatchdogConfig({
        idleTimeoutSeconds: 0.25,
        toolCallOnlyIdleTimeoutSeconds: 0.8,
      }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      await emitToolCallUpdatesForDuration(eventBus, 220, 30);

      eventBus.emitAgentStream(makeThinkingUpdateEvent());

      await emitToolCallUpdatesForDuration(eventBus, 220, 30);

      expect(count()).toBe(0);
    } finally {
      detach();
    }
  });

  test("excluding tool_call_update from activityKinds preserves the legacy primary timeout behavior", async () => {
    const eventBus = new AgentStreamEventBus();
    const { registry, count } = makeCountingRegistry();
    const detach = attachAgentIdleWatchdog(
      eventBus,
      registry,
      makeWatchdogConfig({ activityKinds: ["message_update", "thinking_update", "usage_update"] }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      await emitToolCallUpdatesForDuration(eventBus, 220, 30);

      expect(count()).toBe(1);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "idle_timeout_exceeded")).toBe(true);
    } finally {
      detach();
    }
  });

  test("toolCallOnlyIdleTimeoutSeconds=0 disables the secondary cap", async () => {
    const eventBus = new AgentStreamEventBus();
    const { registry, count } = makeCountingRegistry();
    const detach = attachAgentIdleWatchdog(
      eventBus,
      registry,
      makeWatchdogConfig({ idleTimeoutSeconds: 0.35, toolCallOnlyIdleTimeoutSeconds: 0 }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      await emitToolCallUpdatesForDuration(eventBus, 260, 30);

      expect(count()).toBe(0);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "tool_call_only_idle_timeout_exceeded")).toBe(false);
    } finally {
      detach();
    }
  });

  test("toolCallOnlyIdleTimeoutSeconds less than or equal to the primary timeout does not create an earlier cancel path", async () => {
    const eventBus = new AgentStreamEventBus();
    const { registry, count } = makeCountingRegistry();
    const detach = attachAgentIdleWatchdog(
      eventBus,
      registry,
      makeWatchdogConfig({
        idleTimeoutSeconds: 0.3,
        toolCallOnlyIdleTimeoutSeconds: 0.2,
      }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      // Must run PAST the secondary value (200ms), or the test proves nothing:
      // if it stops short, no tick ever evaluates the secondary condition and
      // the assertion holds even when the "> primary" guard is removed.
      // Tool-call activity keeps refreshing the primary clock, so the 300ms
      // primary timeout is never reached within this window.
      await emitToolCallUpdatesForDuration(eventBus, 280, 30);

      expect(count()).toBe(0);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "tool_call_only_idle_timeout_exceeded")).toBe(false);
    } finally {
      detach();
    }
  });
});
