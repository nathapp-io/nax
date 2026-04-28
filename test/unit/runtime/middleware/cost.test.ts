import { describe, expect, test } from "bun:test";
import { DispatchEventBus } from "../../../../src/runtime/dispatch-events";
import type { CompleteDispatchEvent, DispatchErrorEvent, SessionTurnDispatchEvent } from "../../../../src/runtime/dispatch-events";
import { attachCostSubscriber } from "../../../../src/runtime/middleware/cost";
import { createNoOpCostAggregator, type CostEvent, type CostErrorEvent } from "../../../../src/runtime/cost-aggregator";

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
    turn: 1,
    protocolIds: { sessionId: "sess-1" },
    origin: "runAsSession",
    durationMs: 200,
    timestamp: 1000,
    tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
    exactCostUsd: 0.006,
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
    agentName: "claude",
    stage: "plan",
    storyId: "s-1",
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
    errorMessage: "failed",
    durationMs: 50,
    timestamp: 3000,
    resolvedPermissions: PERMS,
    ...overrides,
  };
}

describe("attachCostSubscriber", () => {
  test("records CostEvent with token usage and exactCostUsd on session-turn", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());

    expect(recorded).toHaveLength(1);
    expect(recorded[0].tokens.input).toBe(100);
    expect(recorded[0].tokens.output).toBe(50);
    expect(recorded[0].tokens.cacheRead).toBe(10);
    expect(recorded[0].tokens.cacheWrite).toBe(5);
    expect(recorded[0].exactCostUsd).toBe(0.006);
    expect(recorded[0].costUsd).toBe(0.006);
    expect(recorded[0].confidence).toBe("exact");
    expect(recorded[0].durationMs).toBe(200);
    expect(recorded[0].model).toBe("unknown");
    expect(recorded[0].storyId).toBe("s-1");
    expect(recorded[0].stage).toBe("run");
    expect(recorded[0].runId).toBe("r-001");
  });

  test("records estimated confidence when no exactCostUsd", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ exactCostUsd: undefined }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].confidence).toBe("estimated");
    expect(recorded[0].costUsd).toBe(0);
    expect(recorded[0].estimatedCostUsd).toBe(0);
  });

  test("skips emit when no tokenUsage and no exactCostUsd", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeCompleteEvent());

    expect(recorded).toHaveLength(0);
  });

  test("records CostEvent for complete event with exactCostUsd", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeCompleteEvent({ exactCostUsd: 0.003 }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].exactCostUsd).toBe(0.003);
    expect(recorded[0].confidence).toBe("exact");
    expect(recorded[0].tokens.input).toBe(0);
    expect(recorded[0].tokens.output).toBe(0);
  });

  test("records CostErrorEvent on dispatch error", () => {
    const errors: CostErrorEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), recordError: (e: CostErrorEvent) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(makeErrorEvent());

    expect(errors).toHaveLength(1);
    expect(errors[0].agentName).toBe("claude");
    expect(errors[0].errorCode).toBe("SESSION_ERROR");
    expect(errors[0].durationMs).toBe(50);
    expect(errors[0].storyId).toBe("s-1");
  });

  test("unsubscribe stops recording", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    const unsub = attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());
    expect(recorded).toHaveLength(1);

    unsub();
    bus.emitDispatch(makeSessionTurnEvent());
    expect(recorded).toHaveLength(1);
  });
});
