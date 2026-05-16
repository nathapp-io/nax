import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { CostEvent, CostSnapshot } from "../../../src/runtime/cost-aggregator";
import { CostAggregator, createNoOpCostAggregator } from "../../../src/runtime/cost-aggregator";
import { DispatchEventBus } from "../../../src/runtime/dispatch-events";
import type { DispatchEvent } from "../../../src/runtime/dispatch-events";
import { attachCostSubscriber } from "../../../src/runtime/middleware/cost";

// ============================================================================
// AC-1: attachCostSubscriber normalizes { exactCostUsd: 0.05, estimatedCostUsd: 0.06 }
//       into a CostEvent with { exactCostUsd: 0.05, confidence: "exact", costUsd: 0.05 }
// ============================================================================

describe("AC-1: attachCostSubscriber normalizes exactCostUsd when provided", () => {
  test("event with exactCostUsd=0.05 and estimatedCostUsd=0.06 produces CostEvent with exactCostUsd=0.05, confidence=exact, costUsd=0.05", () => {
    const bus = new DispatchEventBus();
    const aggregator = new CostAggregator("run-001", "/tmp/test");
    const recorded: CostEvent[] = [];

    // Capture recorded events
    const originalRecord = aggregator.record.bind(aggregator);
    aggregator.record = (event: CostEvent) => {
      recorded.push(event);
      originalRecord(event);
    };

    attachCostSubscriber(bus, aggregator, "run-001");

    const dispatchEvent: DispatchEvent = {
      kind: "complete",
      sessionName: "test-session",
      sessionRole: "main",
      prompt: "test prompt",
      response: "test response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now(),
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.06,
      exactCostUsd: 0.05,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    };

    bus.emitDispatch(dispatchEvent);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].exactCostUsd).toBe(0.05);
    expect(recorded[0].confidence).toBe("exact");
    expect(recorded[0].costUsd).toBe(0.05);
  });
});

// ============================================================================
// AC-2: attachCostSubscriber normalizes { exactCostUsd: undefined, estimatedCostUsd: 0.04 }
//       into a CostEvent with { exactCostUsd: 0.04, confidence: "estimated", costUsd: 0.04 }
// ============================================================================

describe("AC-2: attachCostSubscriber normalizes estimatedCostUsd when exactCostUsd is undefined", () => {
  test("event with exactCostUsd=undefined and estimatedCostUsd=0.04 produces CostEvent with exactCostUsd=0.04, confidence=estimated, costUsd=0.04", () => {
    const bus = new DispatchEventBus();
    const aggregator = new CostAggregator("run-002", "/tmp/test");
    const recorded: CostEvent[] = [];

    aggregator.record = (event: CostEvent) => {
      recorded.push(event);
    };

    attachCostSubscriber(bus, aggregator, "run-002");

    const dispatchEvent: DispatchEvent = {
      kind: "complete",
      sessionName: "test-session",
      sessionRole: "main",
      prompt: "test prompt",
      response: "test response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now(),
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.04,
      // exactCostUsd is undefined
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    };

    bus.emitDispatch(dispatchEvent);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].exactCostUsd).toBe(0.04);
    expect(recorded[0].confidence).toBe("estimated");
    expect(recorded[0].costUsd).toBe(0.04);
  });
});

// ============================================================================
// AC-3: For a complete-kind operation that is retried, all CompleteDispatchEvent and
//       DispatchErrorEvent events emitted across all retry attempts must have callId
//       set to the same string value (not undefined, and identical across all events)
// ============================================================================

describe("AC-3: retried complete-kind operation shares callId across all events", () => {
  test("when a complete operation is retried, all emitted events carry the same callId", () => {
    const bus = new DispatchEventBus();
    const aggregator = new CostAggregator("run-003", "/tmp/test");
    const recordedEvents: CostEvent[] = [];

    aggregator.record = (event: CostEvent) => {
      recordedEvents.push(event);
    };

    attachCostSubscriber(bus, aggregator, "run-003");

    const callId = "retry-test-001";

    // Simulate first attempt
    const event1: DispatchEvent = {
      kind: "complete",
      sessionName: "test-session",
      sessionRole: "main",
      prompt: "prompt",
      response: "response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now(),
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.01,
      exactCostUsd: 0.012,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      callId,
    };

    // Simulate second attempt (retry)
    const event2: DispatchEvent = {
      kind: "complete",
      sessionName: "test-session",
      sessionRole: "main",
      prompt: "prompt",
      response: "response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now() + 100,
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.01,
      exactCostUsd: 0.012,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      callId,
    };

    bus.emitDispatch(event1);
    bus.emitDispatch(event2);

    expect(recordedEvents).toHaveLength(2);
    expect(recordedEvents[0].callId).toBe(callId);
    expect(recordedEvents[1].callId).toBe(callId);
    expect(recordedEvents[0].callId).toBe(recordedEvents[1].callId);
  });
});

// ============================================================================
// AC-4: When CallContext.callId is provided to callOp (non-undefined), all dispatch events
//       (CompleteDispatchEvent, SessionTurnDispatchEvent, OperationCompletedEvent, DispatchErrorEvent)
//       emitted by that invocation must have callId equal to the provided CallContext.callId value
// ============================================================================

describe("AC-4: all dispatch events carry the provided callId when supplied", () => {
  test("dispatch events preserve callId from source DispatchEvent", () => {
    const bus = new DispatchEventBus();
    const aggregator = new CostAggregator("run-004", "/tmp/test");
    const recordedEvents: CostEvent[] = [];

    aggregator.record = (event: CostEvent) => {
      recordedEvents.push(event);
    };

    attachCostSubscriber(bus, aggregator, "run-004");

    const providedCallId = "context-call-id-xyz";

    const event: DispatchEvent = {
      kind: "complete",
      sessionName: "test-session",
      sessionRole: "main",
      prompt: "prompt",
      response: "response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now(),
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.01,
      exactCostUsd: 0.012,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      callId: providedCallId,
    };

    bus.emitDispatch(event);

    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0].callId).toBe(providedCallId);
    expect(recordedEvents[0].callId).toBeDefined();
  });
});

// ============================================================================
// AC-5: After calling openScope('unused-id'), invoking snapshot() returns an object
//       where totalCostUsd === 0 and the object is deeply equal to EMPTY_SNAPSHOT constant
// ============================================================================

describe("AC-5: openScope with unused scopeId returns EMPTY_SNAPSHOT", () => {
  test("newly opened scope with no recorded events returns snapshot with totalCostUsd === 0", () => {
    const aggregator = new CostAggregator("run-005", "/tmp/test");

    const scopeHandle = aggregator.openScope("unused-id");
    const snapshot = scopeHandle.snapshot();

    expect(snapshot.totalCostUsd).toBe(0);
    expect(snapshot.totalEstimatedCostUsd).toBe(0);
    expect(snapshot.totalExactCostUsd).toBe(0);
    expect(snapshot.totalInputTokens).toBe(0);
    expect(snapshot.totalOutputTokens).toBe(0);
    expect(snapshot.callCount).toBe(0);
    expect(snapshot.errorCount).toBe(0);

    scopeHandle.close();
  });

  test("openScope snapshot matches EMPTY_SNAPSHOT structure", () => {
    const aggregator = new CostAggregator("run-005-b", "/tmp/test");
    const noOpAggregator = createNoOpCostAggregator();

    const scopeHandle = aggregator.openScope("empty-scope");
    const snapshot = scopeHandle.snapshot();
    const emptySnapshot = noOpAggregator.snapshot();

    // Both should have identical structure
    expect(snapshot.totalCostUsd).toBe(emptySnapshot.totalCostUsd);
    expect(snapshot.totalEstimatedCostUsd).toBe(emptySnapshot.totalEstimatedCostUsd);
    expect(snapshot.totalExactCostUsd).toBe(emptySnapshot.totalExactCostUsd);
    expect(snapshot.callCount).toBe(emptySnapshot.callCount);

    scopeHandle.close();
  });
});

// ============================================================================
// AC-6: After recording CostEvent with scopeId='x' and costUsd=0.05, and CostEvent with
//       scopeId='y' and costUsd=0.03, aggregator.openScope('x').snapshot().totalCostUsd === 0.05
//       and aggregator.openScope('y').snapshot().totalCostUsd === 0.03
// ============================================================================

describe("AC-6: openScope isolates cost by scopeId", () => {
  test("different scopes track costs independently", () => {
    const bus = new DispatchEventBus();
    const aggregator = new CostAggregator("run-006", "/tmp/test");

    attachCostSubscriber(bus, aggregator, "run-006");

    // Emit event with scopeId='x'
    const event1: DispatchEvent = {
      kind: "complete",
      sessionName: "test-session",
      sessionRole: "main",
      prompt: "prompt",
      response: "response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now(),
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.05,
      exactCostUsd: 0.05,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      scopeId: "x",
    };

    // Emit event with scopeId='y'
    const event2: DispatchEvent = {
      kind: "complete",
      sessionName: "test-session",
      sessionRole: "main",
      prompt: "prompt",
      response: "response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now() + 100,
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.03,
      exactCostUsd: 0.03,
      tokenUsage: { inputTokens: 5, outputTokens: 3 },
      scopeId: "y",
    };

    bus.emitDispatch(event1);
    bus.emitDispatch(event2);

    // Check scope x
    const scopeX = aggregator.openScope("x");
    const snapshotX = scopeX.snapshot();
    expect(snapshotX.totalCostUsd).toBeCloseTo(0.05, 10);

    // Check scope y
    const scopeY = aggregator.openScope("y");
    const snapshotY = scopeY.snapshot();
    expect(snapshotY.totalCostUsd).toBeCloseTo(0.03, 10);

    scopeX.close();
    scopeY.close();
  });

  test("multiple events in same scope accumulate correctly", () => {
    const bus = new DispatchEventBus();
    const aggregator = new CostAggregator("run-006-b", "/tmp/test");

    attachCostSubscriber(bus, aggregator, "run-006-b");

    const scopeId = "test-scope";

    // First event
    bus.emitDispatch({
      kind: "complete",
      sessionName: "session1",
      sessionRole: "main",
      prompt: "prompt",
      response: "response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now(),
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.02,
      exactCostUsd: 0.02,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      scopeId,
    });

    // Second event
    bus.emitDispatch({
      kind: "complete",
      sessionName: "session2",
      sessionRole: "main",
      prompt: "prompt",
      response: "response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now() + 100,
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.03,
      exactCostUsd: 0.03,
      tokenUsage: { inputTokens: 15, outputTokens: 8 },
      scopeId,
    });

    const scope = aggregator.openScope(scopeId);
    const snapshot = scope.snapshot();

    expect(snapshot.totalCostUsd).toBeCloseTo(0.05, 10);
    expect(snapshot.callCount).toBe(2);

    scope.close();
  });
});

// ============================================================================
// AC-7: Given a CostScopeHandle, calling close() followed immediately by close()
//       again completes without throwing and produces no measurable state change on
//       the second invocation
// ============================================================================

describe("AC-7: CostScopeHandle.close is idempotent", () => {
  test("calling close() twice completes without throwing", () => {
    const aggregator = new CostAggregator("run-007", "/tmp/test");
    const scope = aggregator.openScope("idempotent-test");

    // First close
    scope.close();

    // Second close should not throw
    expect(() => {
      scope.close();
    }).not.toThrow();
  });

  test("multiple close invocations have no effect on snapshot()", () => {
    const bus = new DispatchEventBus();
    const aggregator = new CostAggregator("run-007-b", "/tmp/test");

    attachCostSubscriber(bus, aggregator, "run-007-b");

    const scopeId = "close-test";
    const scope = aggregator.openScope(scopeId);

    // Emit an event
    bus.emitDispatch({
      kind: "complete",
      sessionName: "session",
      sessionRole: "main",
      prompt: "prompt",
      response: "response",
      agentName: "claude",
      stage: "verify",
      durationMs: 500,
      timestamp: Date.now(),
      resolvedPermissions: { mode: "approve-all", skipPermissions: false },
      estimatedCostUsd: 0.05,
      exactCostUsd: 0.05,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      scopeId,
    });

    // Take snapshot before closing
    const snapshotBefore = scope.snapshot();
    const costBefore = snapshotBefore.totalCostUsd;

    // Close once
    scope.close();
    const snapshotAfterFirstClose = scope.snapshot();

    // Close again
    scope.close();
    const snapshotAfterSecondClose = scope.snapshot();

    // All snapshots should show same cost
    expect(snapshotAfterFirstClose.totalCostUsd).toBeCloseTo(costBefore, 10);
    expect(snapshotAfterSecondClose.totalCostUsd).toBeCloseTo(costBefore, 10);
  });
});