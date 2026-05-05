import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initLogger, getLogger, resetLogger } from "../../../../src/logger";
import type { LogEntry } from "../../../../src/logger/types";
import { DispatchEventBus } from "../../../../src/runtime/dispatch-events";
import type { CompleteDispatchEvent, DispatchErrorEvent, SessionTurnDispatchEvent } from "../../../../src/runtime/dispatch-events";
import { attachLoggingSubscriber } from "../../../../src/runtime/middleware/logging";
import { cleanupTempDir, makeTempDir } from "../../../helpers";

const PERMS = { mode: "approve-reads" as const, skipPermissions: false };

function makeSessionTurnEvent(overrides: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "nax-abc-feat-s1-main",
    sessionRole: "main",
    prompt: "hello",
    response: "world",
    agentName: "claude",
    stage: "run",
    storyId: "s-42",
    resolvedPermissions: PERMS,
    turn: 1,
    protocolIds: { sessionId: "sess-1" },
    origin: "runAsSession",
    durationMs: 350,
    timestamp: 1000,
    ...overrides,
  };
}

function makeCompleteEvent(overrides: Partial<CompleteDispatchEvent> = {}): CompleteDispatchEvent {
  return {
    kind: "complete",
    sessionName: "nax-abc-feat-s1-plan",
    sessionRole: "plan",
    prompt: "plan this",
    response: "planned",
    agentName: "codex",
    stage: "plan",
    storyId: "s-42",
    resolvedPermissions: PERMS,
    durationMs: 80,
    timestamp: 2000,
    ...overrides,
  };
}

function makeErrorEvent(overrides: Partial<DispatchErrorEvent> = {}): DispatchErrorEvent {
  return {
    kind: "error",
    origin: "runAsSession",
    agentName: "claude",
    stage: "run",
    storyId: "s-42",
    errorCode: "SESSION_ERROR",
    errorMessage: "session lost",
    durationMs: 100,
    timestamp: 3000,
    resolvedPermissions: PERMS,
    ...overrides,
  };
}

async function parseLastEntry(logFile: string): Promise<LogEntry> {
  const content = await Bun.file(logFile).text();
  const lines = content.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as LogEntry;
}

describe("attachLoggingSubscriber", () => {
  let logFile: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-logging-sub-");
    logFile = join(tmpDir, `test-logging-sub-${Date.now()}.jsonl`);
    initLogger({ level: "debug", filePath: logFile, useChalk: false, headless: true });
  });

  afterEach(async () => {
    await getLogger().flush();
    resetLogger();
    cleanupTempDir(tmpDir);
  });

  test("logs Agent call complete on session-turn dispatch", async () => {
    const bus = new DispatchEventBus();
    attachLoggingSubscriber(bus, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ agentName: "codex", stage: "verify", durationMs: 350 }));
    await getLogger().flush();

    const entry = await parseLastEntry(logFile);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("Agent call complete");
    expect(entry.data).toMatchObject({
      agentName: "codex",
      kind: "session-turn",
      stage: "verify",
      durationMs: 350,
      storyId: "s-42",
      runId: "r-001",
    });
  });

  test("logs Agent call complete on complete dispatch", async () => {
    const bus = new DispatchEventBus();
    attachLoggingSubscriber(bus, "r-001");

    bus.emitDispatch(makeCompleteEvent({ agentName: "claude", stage: "plan" }));
    await getLogger().flush();

    const entry = await parseLastEntry(logFile);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("Agent call complete");
    expect(entry.data?.agentName).toBe("claude");
    expect(entry.data?.kind).toBe("complete");
  });

  test("logs Agent call failed on dispatch error", async () => {
    const bus = new DispatchEventBus();
    attachLoggingSubscriber(bus, "r-001");

    bus.emitDispatchError(makeErrorEvent({ agentName: "claude", stage: "run", durationMs: 100 }));
    await getLogger().flush();

    const entry = await parseLastEntry(logFile);
    expect(entry.level).toBe("warn");
    expect(entry.message).toBe("Agent call failed");
    expect(entry.data).toMatchObject({
      agentName: "claude",
      stage: "run",
      durationMs: 100,
      error: "session lost",
      storyId: "s-42",
      runId: "r-001",
    });
  });

  test("is a no-op when logger is not initialized", () => {
    resetLogger();
    const bus = new DispatchEventBus();
    attachLoggingSubscriber(bus, "r-001");
    expect(() => bus.emitDispatch(makeSessionTurnEvent())).not.toThrow();
    expect(() => bus.emitDispatchError(makeErrorEvent())).not.toThrow();
  });

  test("unsubscribe stops logging", async () => {
    const bus = new DispatchEventBus();

    // Emit once before unsubscribing to create the log file
    const unsub = attachLoggingSubscriber(bus, "r-001");
    bus.emitDispatch(makeSessionTurnEvent());
    await getLogger().flush();

    const contentBefore = await Bun.file(logFile).text();
    const linesBefore = contentBefore.trim().split("\n").filter(Boolean).length;

    unsub();
    bus.emitDispatch(makeSessionTurnEvent());
    await getLogger().flush();

    const contentAfter = await Bun.file(logFile).text();
    const linesAfter = contentAfter.trim().split("\n").filter(Boolean).length;
    expect(linesAfter).toBe(linesBefore);
  });
});
