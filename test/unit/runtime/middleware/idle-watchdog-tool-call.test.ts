import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getLogger, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";
import { AgentStreamEventBus, attachAgentIdleWatchdog, type AgentStreamEvent } from "@/runtime";
import { cleanupTempDir, makeTempDir, makeNaxConfig, waitForCondition } from "@test/helpers";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function emitToolCallUpdatesForDuration(
  eventBus: AgentStreamEventBus,
  durationMs: number,
  intervalMs = 25,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    eventBus.emitAgentStream(makeToolCallUpdateEvent());
    await sleep(intervalMs);
  }
  // Keep the final activity timestamp fresh for immediate post-loop assertions.
  eventBus.emitAgentStream(makeToolCallUpdateEvent());
}

type ActivityKind = "message_update" | "thinking_update" | "usage_update" | "tool_call_update";

function makeWatchdogConfig(overrides: {
  mode?: "off" | "observe" | "warn-then-cancel" | "cancel";
  idleTimeoutSeconds?: number;
  toolCallOnlyIdleTimeoutSeconds?: number;
  activityKinds?: ActivityKind[];
} = {}) {
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

function makeBaseEvent(timestamp = Date.now()) {
  return {
    callId: "call-123",
    runId: "run-001",
    agentName: "claude",
    sessionName: "test-session",
    storyId: "story-42",
    stage: "run" as const,
    pid: 1234,
    timestamp,
  };
}

function makeCallStartedEvent(timestamp = Date.now()): AgentStreamEvent {
  return {
    ...makeBaseEvent(timestamp),
    kind: "agent.call_started",
    model: "claude-sonnet-4-5",
    timeoutSeconds: 60,
  };
}

function makeThinkingUpdateEvent(timestamp = Date.now()): AgentStreamEvent {
  return {
    ...makeBaseEvent(timestamp),
    kind: "agent.thinking_update",
    deltaBytes: 12,
  };
}

function makeToolCallUpdateEvent(timestamp = Date.now()): AgentStreamEvent {
  return {
    ...makeBaseEvent(timestamp),
    kind: "agent.tool_call_update",
    toolName: "bash",
  };
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
    tmpDir = makeTempDir("nax-test-idle-watchdog-tool-");
    logFile = join(tmpDir, `idle-watchdog-tool-${Date.now()}.jsonl`);
    initLogger({ level: "silent", filePath: logFile });
  });

  afterEach(async () => {
    await getLogger().flush();
    resetLogger();
    cleanupTempDir(tmpDir);
  });

  test("tool-call updates keep the primary idle timeout alive until the secondary cap is reached", async () => {
    const eventBus = new AgentStreamEventBus();
    let cancelCount = 0;
    const registry = new Map<string, () => Promise<void>>([
      [
        "call-123",
        async () => {
          cancelCount++;
        },
      ],
    ]);
    const detach = attachAgentIdleWatchdog(
      eventBus,
      registry,
      makeWatchdogConfig({ idleTimeoutSeconds: 0.25, toolCallOnlyIdleTimeoutSeconds: 0.7 }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      await emitToolCallUpdatesForDuration(eventBus, 220, 30);

      expect(cancelCount).toBe(0);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "idle_timeout_exceeded")).toBe(false);
    } finally {
      detach();
    }
  });

  test("tool-call-only activity hits the secondary timeout with a distinct log key", async () => {
    const eventBus = new AgentStreamEventBus();
    let cancelCount = 0;
    const registry = new Map<string, () => Promise<void>>([
      [
        "call-123",
        async () => {
          cancelCount++;
        },
      ],
    ]);
    const detach = attachAgentIdleWatchdog(eventBus, registry, makeWatchdogConfig());

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      await emitToolCallUpdatesForDuration(eventBus, 220, 25);
      await waitForCondition(() => cancelCount === 1, 1_000, 10);

      expect(cancelCount).toBe(1);
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
    let cancelCount = 0;
    const registry = new Map<string, () => Promise<void>>([
      [
        "call-123",
        async () => {
          cancelCount++;
        },
      ],
    ]);
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

      expect(cancelCount).toBe(0);
    } finally {
      detach();
    }
  });

  test("excluding tool_call_update from activityKinds preserves the legacy primary timeout behavior", async () => {
    const eventBus = new AgentStreamEventBus();
    let cancelCount = 0;
    const registry = new Map<string, () => Promise<void>>([
      [
        "call-123",
        async () => {
          cancelCount++;
        },
      ],
    ]);
    const detach = attachAgentIdleWatchdog(
      eventBus,
      registry,
      makeWatchdogConfig({ activityKinds: ["message_update", "thinking_update", "usage_update"] }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      await emitToolCallUpdatesForDuration(eventBus, 220, 30);
      await waitForCondition(() => cancelCount === 1, 1_000, 10);

      expect(cancelCount).toBe(1);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "idle_timeout_exceeded")).toBe(true);
    } finally {
      detach();
    }
  });

  test("toolCallOnlyIdleTimeoutSeconds=0 disables the secondary cap", async () => {
    const eventBus = new AgentStreamEventBus();
    let cancelCount = 0;
    const registry = new Map<string, () => Promise<void>>([
      [
        "call-123",
        async () => {
          cancelCount++;
        },
      ],
    ]);
    const detach = attachAgentIdleWatchdog(
      eventBus,
      registry,
      makeWatchdogConfig({ idleTimeoutSeconds: 0.35, toolCallOnlyIdleTimeoutSeconds: 0 }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      await emitToolCallUpdatesForDuration(eventBus, 260, 30);

      expect(cancelCount).toBe(0);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "tool_call_only_idle_timeout_exceeded")).toBe(false);
    } finally {
      detach();
    }
  });

  test("toolCallOnlyIdleTimeoutSeconds less than or equal to the primary timeout does not create an earlier cancel path", async () => {
    const eventBus = new AgentStreamEventBus();
    let cancelCount = 0;
    const registry = new Map<string, () => Promise<void>>([
      [
        "call-123",
        async () => {
          cancelCount++;
        },
      ],
    ]);
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
      await emitToolCallUpdatesForDuration(eventBus, 180, 30);

      expect(cancelCount).toBe(0);
      await getLogger().flush();
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "tool_call_only_idle_timeout_exceeded")).toBe(false);
    } finally {
      detach();
    }
  });
});
