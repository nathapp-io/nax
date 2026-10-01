import { describe, expect, test } from "bun:test";
import {
  type AgentCallEndedEvent,
  type AgentCallStartedEvent,
  type AgentStreamEvent,
  AgentStreamEventBus,
  narrowStreamStage,
} from "@/runtime/agent-stream-events";

function makeCallStartedEvent(overrides: Partial<AgentCallStartedEvent> = {}): AgentCallStartedEvent {
  return {
    kind: "agent.call_started",
    callId: "call-1",
    runId: "run-1",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    timestamp: 1000,
    model: "claude-sonnet-4-6",
    timeoutSeconds: 120,
    ...overrides,
  };
}

function makeCallEndedEvent(overrides: Partial<AgentCallEndedEvent> = {}): AgentCallEndedEvent {
  return {
    kind: "agent.call_ended",
    callId: "call-1",
    runId: "run-1",
    agentName: "claude",
    sessionName: "nax-abc-feat-s1-main",
    timestamp: 2000,
    status: "success",
    ...overrides,
  };
}

describe("AgentStreamEventBus", () => {
  describe("emitAgentStream delivers to registered listeners", () => {
    test("delivers event to a single registered listener", () => {
      const bus = new AgentStreamEventBus();
      const received: AgentStreamEvent[] = [];
      bus.onAgentStream((e) => received.push(e));

      const event = makeCallStartedEvent();
      bus.emitAgentStream(event);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(event);
    });

    test("delivers event to multiple registered listeners", () => {
      const bus = new AgentStreamEventBus();
      const a: AgentStreamEvent[] = [];
      const b: AgentStreamEvent[] = [];
      bus.onAgentStream((e) => a.push(e));
      bus.onAgentStream((e) => b.push(e));

      const event = makeCallStartedEvent();
      bus.emitAgentStream(event);

      expect(a).toHaveLength(1);
      expect(a[0]).toBe(event);
      expect(b).toHaveLength(1);
      expect(b[0]).toBe(event);
    });

    test("delivers different event kinds correctly", () => {
      const bus = new AgentStreamEventBus();
      const received: AgentStreamEvent[] = [];
      bus.onAgentStream((e) => received.push(e));

      const started = makeCallStartedEvent();
      const ended = makeCallEndedEvent();
      bus.emitAgentStream(started);
      bus.emitAgentStream(ended);

      expect(received).toHaveLength(2);
      expect(received[0]).toBe(started);
      expect(received[1]).toBe(ended);
    });
  });

  describe("onAgentStream returns unsubscribe function", () => {
    test("unsubscribe stops delivery to that listener", () => {
      const bus = new AgentStreamEventBus();
      const received: AgentStreamEvent[] = [];
      const off = bus.onAgentStream((e) => received.push(e));

      bus.emitAgentStream(makeCallStartedEvent());
      off();
      bus.emitAgentStream(makeCallStartedEvent());

      expect(received).toHaveLength(1);
    });

    test("unsubscribe only removes the specific listener", () => {
      const bus = new AgentStreamEventBus();
      const a: AgentStreamEvent[] = [];
      const b: AgentStreamEvent[] = [];
      const offA = bus.onAgentStream((e) => a.push(e));
      bus.onAgentStream((e) => b.push(e));

      bus.emitAgentStream(makeCallStartedEvent());
      offA();
      bus.emitAgentStream(makeCallStartedEvent());

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(2);
    });

    test("calling unsubscribe twice is safe", () => {
      const bus = new AgentStreamEventBus();
      const received: AgentStreamEvent[] = [];
      const off = bus.onAgentStream((e) => received.push(e));

      off();
      expect(() => off()).not.toThrow();
      bus.emitAgentStream(makeCallStartedEvent());

      expect(received).toHaveLength(0);
    });
  });

  describe("listener exception isolation", () => {
    test("throwing listener does not prevent other listeners from receiving the event", () => {
      const bus = new AgentStreamEventBus();
      const received: AgentStreamEvent[] = [];
      bus.onAgentStream(() => {
        throw new Error("listener boom");
      });
      bus.onAgentStream((e) => received.push(e));

      const event = makeCallStartedEvent();
      expect(() => bus.emitAgentStream(event)).not.toThrow();
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(event);
    });

    test("all non-throwing listeners still receive event when middle listener throws", () => {
      const bus = new AgentStreamEventBus();
      const a: AgentStreamEvent[] = [];
      const b: AgentStreamEvent[] = [];
      bus.onAgentStream((e) => a.push(e));
      bus.onAgentStream(() => {
        throw new Error("middle throws");
      });
      bus.onAgentStream((e) => b.push(e));

      bus.emitAgentStream(makeCallStartedEvent());

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });
  });

  describe("no buffering — events are not retained after delivery", () => {
    test("listener added after emit does not receive prior events", () => {
      const bus = new AgentStreamEventBus();

      bus.emitAgentStream(makeCallStartedEvent());

      const received: AgentStreamEvent[] = [];
      bus.onAgentStream((e) => received.push(e));

      expect(received).toHaveLength(0);
    });

    test("bus with no listeners emits without error and retains nothing", () => {
      const bus = new AgentStreamEventBus();
      expect(() => bus.emitAgentStream(makeCallStartedEvent())).not.toThrow();

      const received: AgentStreamEvent[] = [];
      bus.onAgentStream((e) => received.push(e));
      expect(received).toHaveLength(0);
    });
  });
});

describe("narrowStreamStage — nax re-narrows the contract's plain-string stage (S1-2 carried item)", () => {
  const base: AgentStreamEvent = {
    kind: "agent.call_started",
    callId: "c1",
    runId: "r1",
    agentName: "native",
    sessionName: "s1",
    timestamp: 1,
    model: "anthropic/claude-haiku-4-5",
    timeoutSeconds: 60,
  };

  test("an event without a stage passes through as the same object", () => {
    expect<AgentStreamEvent>(narrowStreamStage(base)).toBe(base);
  });

  test("a known pipeline stage passes through as the same object", () => {
    const event: AgentStreamEvent = { ...base, stage: "run" };
    expect<AgentStreamEvent>(narrowStreamStage(event)).toBe(event);
  });

  test("an unknown stage label is dropped, never passed on", () => {
    const narrowed = narrowStreamStage({ ...base, stage: "native-session" });
    expect(narrowed.stage).toBeUndefined();
    expect(narrowed.callId).toBe("c1");
  });

  test("the bus hands listeners the narrowed event", () => {
    const bus = new AgentStreamEventBus();
    const seen: (string | undefined)[] = [];
    bus.onAgentStream((event) => seen.push(event.stage));
    bus.emitAgentStream({ ...base, stage: "native-session" });
    bus.emitAgentStream({ ...base, stage: "review" });
    expect(seen).toEqual([undefined, "review"]);
  });
});
