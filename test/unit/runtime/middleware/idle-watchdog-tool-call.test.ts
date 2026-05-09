import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getLogger, initLogger, resetLogger } from "../../../../src/logger";
import type { LogEntry } from "../../../../src/logger/types";
import { AgentStreamEventBus, type AgentStreamEvent } from "../../../../src/runtime/agent-stream-events";
import { attachAgentIdleWatchdog } from "../../../../src/runtime/middleware/idle-watchdog";
import { makeNaxConfig } from "../../../helpers";
import { cleanupTempDir, makeTempDir } from "../../../helpers";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
        idleTimeoutSeconds: 0.04,
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
    initLogger({ level: "debug", filePath: logFile, useChalk: false, headless: true });
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
      makeWatchdogConfig({ toolCallOnlyIdleTimeoutSeconds: 0.25 }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      const startedAt = Date.now();
      while (Date.now() - startedAt < 70) {
        eventBus.emitAgentStream(makeToolCallUpdateEvent());
        await sleep(15);
      }
      await sleep(10);

      expect(cancelCount).toBe(0);
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
      const startedAt = Date.now();
      while (Date.now() - startedAt < 170) {
        eventBus.emitAgentStream(makeToolCallUpdateEvent());
        await sleep(15);
      }
      await sleep(40);

      expect(cancelCount).toBe(1);
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
        idleTimeoutSeconds: 0.08,
        toolCallOnlyIdleTimeoutSeconds: 0.2,
      }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      const firstWindowStart = Date.now();
      while (Date.now() - firstWindowStart < 60) {
        eventBus.emitAgentStream(makeToolCallUpdateEvent());
        await sleep(15);
      }

      eventBus.emitAgentStream(makeThinkingUpdateEvent());

      const secondWindowStart = Date.now();
      while (Date.now() - secondWindowStart < 60) {
        eventBus.emitAgentStream(makeToolCallUpdateEvent());
        await sleep(15);
      }

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
      const startedAt = Date.now();
      while (Date.now() - startedAt < 90) {
        eventBus.emitAgentStream(makeToolCallUpdateEvent());
        await sleep(15);
      }
      await sleep(30);

      expect(cancelCount).toBe(1);
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
      makeWatchdogConfig({ toolCallOnlyIdleTimeoutSeconds: 0 }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      const startedAt = Date.now();
      while (Date.now() - startedAt < 170) {
        eventBus.emitAgentStream(makeToolCallUpdateEvent());
        await sleep(15);
      }
      await sleep(10);

      expect(cancelCount).toBe(0);
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
        idleTimeoutSeconds: 0.12,
        toolCallOnlyIdleTimeoutSeconds: 0.08,
      }),
    );

    try {
      eventBus.emitAgentStream(makeCallStartedEvent());
      const startedAt = Date.now();
      while (Date.now() - startedAt < 70) {
        eventBus.emitAgentStream(makeToolCallUpdateEvent());
        await sleep(15);
      }
      await sleep(10);

      expect(cancelCount).toBe(0);
      const entries = await parseAllEntries(logFile);
      expect(entries.some((entry) => entry.data?.key === "tool_call_only_idle_timeout_exceeded")).toBe(false);
    } finally {
      detach();
    }
  });
});
