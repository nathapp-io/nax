import { describe, expect, test } from "bun:test";
import { DispatchEventBus } from "../../../../src/runtime/dispatch-events";
import type { CompleteDispatchEvent, DispatchErrorEvent, SessionTurnDispatchEvent } from "../../../../src/runtime/dispatch-events";
import { attachAuditSubscriber } from "../../../../src/runtime/middleware/audit";
import {
  createNoOpPromptAuditor,
  type PromptAuditEntry,
  type PromptAuditErrorEntry,
} from "../../../../src/runtime/prompt-auditor";

const PERMS = { mode: "approve-reads" as const, skipPermissions: false };

function makeSessionTurnEvent(overrides: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "nax-abc-feat-s1-main",
    sessionRole: "main",
    prompt: "Do the thing",
    response: "Done",
    agentName: "claude",
    stage: "run",
    storyId: "s-1",
    featureName: "feat",
    workdir: "/tmp/w",
    projectDir: "/tmp/p",
    resolvedPermissions: PERMS,
    turn: 2,
    protocolIds: { sessionId: "sess-1", recordId: "rec-1" },
    origin: "runAsSession",
    durationMs: 150,
    timestamp: 1000,
    ...overrides,
  };
}

function makeCompleteEvent(overrides: Partial<CompleteDispatchEvent> = {}): CompleteDispatchEvent {
  return {
    kind: "complete",
    sessionName: "nax-abc-feat-s1-plan",
    sessionRole: "plan",
    prompt: "Plan this",
    response: "Planned",
    agentName: "claude",
    stage: "plan",
    storyId: "s-1",
    featureName: "feat",
    workdir: "/tmp/w",
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
    storyId: "s-1",
    errorCode: "SESSION_ERROR",
    errorMessage: "session lost",
    prompt: "hello",
    durationMs: 42,
    timestamp: 3000,
    resolvedPermissions: PERMS,
    ...overrides,
  };
}

describe("attachAuditSubscriber", () => {
  test("records PromptAuditEntry on session-turn dispatch", () => {
    const recorded: PromptAuditEntry[] = [];
    const auditor = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachAuditSubscriber(bus, auditor, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());

    expect(recorded).toHaveLength(1);
    expect(recorded[0].prompt).toBe("Do the thing");
    expect(recorded[0].response).toBe("Done");
    expect(recorded[0].callType).toBe("run");
    expect(recorded[0].sessionName).toBe("nax-abc-feat-s1-main");
    expect(recorded[0].sessionId).toBe("sess-1");
    expect(recorded[0].recordId).toBe("rec-1");
    expect(recorded[0].turn).toBe(2);
    expect(recorded[0].permissionProfile).toBe("approve-reads");
    expect(recorded[0].durationMs).toBe(150);
    expect(recorded[0].agentName).toBe("claude");
    expect(recorded[0].storyId).toBe("s-1");
    expect(recorded[0].workdir).toBe("/tmp/w");
    expect(recorded[0].projectDir).toBe("/tmp/p");
    expect(recorded[0].featureName).toBe("feat");
    expect(recorded[0].runId).toBe("r-001");
  });

  test("records PromptAuditEntry on complete dispatch with callType=complete", () => {
    const recorded: PromptAuditEntry[] = [];
    const auditor = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachAuditSubscriber(bus, auditor, "r-001");

    bus.emitDispatch(makeCompleteEvent());

    expect(recorded).toHaveLength(1);
    expect(recorded[0].callType).toBe("complete");
    expect(recorded[0].prompt).toBe("Plan this");
    expect(recorded[0].response).toBe("Planned");
    expect(recorded[0].sessionName).toBe("nax-abc-feat-s1-plan");
    expect(recorded[0].turn).toBeUndefined();
    expect(recorded[0].sessionId).toBeUndefined();
    expect(recorded[0].recordId).toBeUndefined();
  });

  test("session-turn dispatch with missing recordId records null", () => {
    const recorded: PromptAuditEntry[] = [];
    const auditor = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachAuditSubscriber(bus, auditor, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ protocolIds: { sessionId: "sess-x" } }));

    expect(recorded[0].sessionId).toBe("sess-x");
    expect(recorded[0].recordId).toBeNull();
  });

  test("records PromptAuditErrorEntry on dispatch error", () => {
    const errors: PromptAuditErrorEntry[] = [];
    const auditor = { ...createNoOpPromptAuditor(), recordError: (e: PromptAuditErrorEntry) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachAuditSubscriber(bus, auditor, "r-001");

    bus.emitDispatchError(makeErrorEvent());

    expect(errors).toHaveLength(1);
    expect(errors[0].agentName).toBe("claude");
    expect(errors[0].errorCode).toBe("SESSION_ERROR");
    expect(errors[0].errorMessage).toBe("session lost");
    expect(errors[0].callType).toBe("run");
    expect(errors[0].prompt).toBe("hello");
    expect(errors[0].permissionProfile).toBe("approve-reads");
    expect(errors[0].durationMs).toBe(42);
    expect(errors[0].storyId).toBe("s-1");
  });

  test("error from completeAs maps callType=complete", () => {
    const errors: PromptAuditErrorEntry[] = [];
    const auditor = { ...createNoOpPromptAuditor(), recordError: (e: PromptAuditErrorEntry) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachAuditSubscriber(bus, auditor, "r-001");

    bus.emitDispatchError(makeErrorEvent({ origin: "completeAs" }));

    expect(errors[0].callType).toBe("complete");
  });

  test("unsubscribe stops recording", () => {
    const recorded: PromptAuditEntry[] = [];
    const auditor = { ...createNoOpPromptAuditor(), record: (e: PromptAuditEntry) => recorded.push(e) };
    const bus = new DispatchEventBus();
    const unsub = attachAuditSubscriber(bus, auditor, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());
    expect(recorded).toHaveLength(1);

    unsub();
    bus.emitDispatch(makeSessionTurnEvent());
    expect(recorded).toHaveLength(1);
  });
});
