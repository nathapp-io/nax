import { describe, expect, test } from "bun:test";
import {
  DispatchEventBus,
  type DispatchEvent,
  type DispatchErrorEvent,
  type OperationCompletedEvent,
  type ReviewDecisionEvent,
  type SessionTurnDispatchEvent,
} from "../../../src/runtime/dispatch-events";

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
    storyId: "s-1",
    resolvedPermissions: PERMS,
    turn: 0,
    protocolIds: { sessionId: "sess-1" },
    origin: "runAsSession",
    durationMs: 100,
    timestamp: 1000,
    ...overrides,
  };
}

function makeErrorEvent(overrides: Partial<DispatchErrorEvent> = {}): DispatchErrorEvent {
  return {
    kind: "error",
    origin: "runAsSession",
    agentName: "claude",
    stage: "run",
    errorCode: "SESSION_ERROR",
    errorMessage: "session lost",
    durationMs: 50,
    timestamp: 2000,
    resolvedPermissions: PERMS,
    ...overrides,
  };
}

function makeOperationEvent(overrides: Partial<OperationCompletedEvent> = {}): OperationCompletedEvent {
  return {
    kind: "operation-completed",
    operation: "run-with-fallback",
    agentChain: ["claude"],
    hopCount: 1,
    fallbackTriggered: false,
    totalElapsedMs: 200,
    totalCostUsd: 0.001,
    finalStatus: "ok",
    stage: "run",
    timestamp: 3000,
    ...overrides,
  };
}

describe("DispatchEventBus", () => {
  describe("onDispatch / emitDispatch", () => {
    test("delivers event to registered listener", () => {
      const bus = new DispatchEventBus();
      const received: DispatchEvent[] = [];
      bus.onDispatch((e) => received.push(e));

      const event = makeSessionTurnEvent();
      bus.emitDispatch(event);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(event);
    });

    test("delivers to multiple listeners", () => {
      const bus = new DispatchEventBus();
      const a: DispatchEvent[] = [];
      const b: DispatchEvent[] = [];
      bus.onDispatch((e) => a.push(e));
      bus.onDispatch((e) => b.push(e));

      bus.emitDispatch(makeSessionTurnEvent());

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    test("unsubscribe stops delivery", () => {
      const bus = new DispatchEventBus();
      const received: DispatchEvent[] = [];
      const off = bus.onDispatch((e) => received.push(e));

      bus.emitDispatch(makeSessionTurnEvent());
      off();
      bus.emitDispatch(makeSessionTurnEvent());

      expect(received).toHaveLength(1);
    });

    test("listener that throws does not break other listeners", () => {
      const bus = new DispatchEventBus();
      const received: DispatchEvent[] = [];
      bus.onDispatch(() => { throw new Error("boom"); });
      bus.onDispatch((e) => received.push(e));

      expect(() => bus.emitDispatch(makeSessionTurnEvent())).not.toThrow();
      expect(received).toHaveLength(1);
    });
  });

  describe("onDispatchError / emitDispatchError", () => {
    test("delivers error event to registered listener", () => {
      const bus = new DispatchEventBus();
      const received: DispatchErrorEvent[] = [];
      bus.onDispatchError((e) => received.push(e));

      const event = makeErrorEvent();
      bus.emitDispatchError(event);

      expect(received).toHaveLength(1);
      expect(received[0].errorCode).toBe("SESSION_ERROR");
    });

    test("unsubscribe stops error delivery", () => {
      const bus = new DispatchEventBus();
      const received: DispatchErrorEvent[] = [];
      const off = bus.onDispatchError((e) => received.push(e));

      bus.emitDispatchError(makeErrorEvent());
      off();
      bus.emitDispatchError(makeErrorEvent());

      expect(received).toHaveLength(1);
    });

    test("error listener that throws does not break others", () => {
      const bus = new DispatchEventBus();
      const received: DispatchErrorEvent[] = [];
      bus.onDispatchError(() => { throw new Error("listener broke"); });
      bus.onDispatchError((e) => received.push(e));

      expect(() => bus.emitDispatchError(makeErrorEvent())).not.toThrow();
      expect(received).toHaveLength(1);
    });
  });

  describe("onOperationCompleted / emitOperationCompleted", () => {
    test("delivers operation-completed event to listener", () => {
      const bus = new DispatchEventBus();
      const received: OperationCompletedEvent[] = [];
      bus.onOperationCompleted((e) => received.push(e));

      const event = makeOperationEvent({ fallbackTriggered: true, hopCount: 2 });
      bus.emitOperationCompleted(event);

      expect(received).toHaveLength(1);
      expect(received[0].hopCount).toBe(2);
      expect(received[0].fallbackTriggered).toBe(true);
    });

    test("unsubscribe stops operation-completed delivery", () => {
      const bus = new DispatchEventBus();
      const received: OperationCompletedEvent[] = [];
      const off = bus.onOperationCompleted((e) => received.push(e));

      bus.emitOperationCompleted(makeOperationEvent());
      off();
      bus.emitOperationCompleted(makeOperationEvent());

      expect(received).toHaveLength(1);
    });
  });

  test("dispatch events do not leak to error listeners", () => {
    const bus = new DispatchEventBus();
    const errorReceived: DispatchErrorEvent[] = [];
    bus.onDispatchError((e) => errorReceived.push(e));

    bus.emitDispatch(makeSessionTurnEvent());

    expect(errorReceived).toHaveLength(0);
  });

  test("error events do not leak to dispatch listeners", () => {
    const bus = new DispatchEventBus();
    const dispatchReceived: DispatchEvent[] = [];
    bus.onDispatch((e) => dispatchReceived.push(e));

    bus.emitDispatchError(makeErrorEvent());

    expect(dispatchReceived).toHaveLength(0);
  });
});

function makeReviewDecisionEvent(overrides: Partial<ReviewDecisionEvent> = {}): ReviewDecisionEvent {
  return {
    kind: "review-decision",
    reviewer: "semantic",
    timestamp: 5000,
    parsed: true,
    result: { passed: true, findings: [] },
    ...overrides,
  };
}

describe("onReviewDecision / emitReviewDecision", () => {
  test("delivers review-decision event to registered listener", () => {
    const bus = new DispatchEventBus();
    const received: ReviewDecisionEvent[] = [];
    bus.onReviewDecision((e) => received.push(e));

    const event = makeReviewDecisionEvent();
    bus.emitReviewDecision(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
    expect(received[0].kind).toBe("review-decision");
  });

  test("delivers to multiple listeners", () => {
    const bus = new DispatchEventBus();
    const a: ReviewDecisionEvent[] = [];
    const b: ReviewDecisionEvent[] = [];
    bus.onReviewDecision((e) => a.push(e));
    bus.onReviewDecision((e) => b.push(e));

    bus.emitReviewDecision(makeReviewDecisionEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new DispatchEventBus();
    const received: ReviewDecisionEvent[] = [];
    const off = bus.onReviewDecision((e) => received.push(e));

    bus.emitReviewDecision(makeReviewDecisionEvent());
    off();
    bus.emitReviewDecision(makeReviewDecisionEvent());

    expect(received).toHaveLength(1);
  });

  test("listener that throws does not break other listeners", () => {
    const bus = new DispatchEventBus();
    const received: ReviewDecisionEvent[] = [];
    bus.onReviewDecision(() => { throw new Error("boom"); });
    bus.onReviewDecision((e) => received.push(e));

    expect(() => bus.emitReviewDecision(makeReviewDecisionEvent())).not.toThrow();
    expect(received).toHaveLength(1);
  });

  test("review-decision events do not leak to dispatch listeners", () => {
    const bus = new DispatchEventBus();
    const dispatchReceived: DispatchEvent[] = [];
    bus.onDispatch((e) => dispatchReceived.push(e));

    bus.emitReviewDecision(makeReviewDecisionEvent());

    expect(dispatchReceived).toHaveLength(0);
  });
});
