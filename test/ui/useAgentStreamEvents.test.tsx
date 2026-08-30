/**
 * useAgentStreamEvents — per-call state and token totals for the Live Activity panel.
 *
 * The hook buffers stream events into refs and drains them into React state on a
 * 150ms interval, so every assertion here emits through a real AgentStreamEventBus
 * and then waits for a drain tick rather than reading the refs directly.
 */

import { describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { type AgentStreamEvent, AgentStreamEventBus, type IAgentStreamEventBus } from "@/runtime";
import { useAgentStreamEvents } from "@/tui/hooks/useAgentStreamEvents";

/** Comfortably longer than the hook's 150ms RENDER_INTERVAL_MS. */
const DRAIN_WAIT_MS = 220;

const CALL_ID = "call-1";

/** A call_started event with every optional field populated. */
function started(overrides: Partial<AgentStreamEvent> = {}): AgentStreamEvent {
  return {
    kind: "agent.call_started",
    callId: CALL_ID,
    runId: "run-1",
    agentName: "claude",
    sessionName: "nax-US-001",
    storyId: "US-001",
    stage: "execution",
    timestamp: 1_000,
    model: "claude-opus-5",
    timeoutSeconds: 600,
    ...overrides,
  } as AgentStreamEvent;
}

/** Any non-started event for the same call, with the fields that kind carries. */
function update(kind: string, extra: Record<string, unknown> = {}): AgentStreamEvent {
  return {
    kind,
    callId: CALL_ID,
    runId: "run-1",
    agentName: "claude",
    sessionName: "nax-US-001",
    timestamp: 2_000,
    ...extra,
  } as AgentStreamEvent;
}

/**
 * Renders the hook's state one short field per line — a single wide line wraps at
 * ink-testing-library's default width and breaks `toContain`.
 */
function HookOutput({ bus }: { bus?: IAgentStreamEventBus | null }) {
  const { activeCalls, inputTokens, outputTokens } = useAgentStreamEvents(bus);
  const call = activeCalls.get(CALL_ID);
  return (
    <Box flexDirection="column">
      <Text>calls:{activeCalls.size}</Text>
      <Text>agent:{call?.agentName ?? "none"}</Text>
      <Text>model:{call?.model ?? "none"}</Text>
      <Text>story:{call?.storyId ?? "none"}</Text>
      <Text>stage:{call?.stage ?? "none"}</Text>
      <Text>status:{call?.status ?? "none"}</Text>
      <Text>msg:{call?.messageUpdates ?? -1}</Text>
      <Text>think:{call?.thinkingUpdates ?? -1}</Text>
      <Text>usage:{call?.usageUpdates ?? -1}</Text>
      <Text>tools:{call?.toolCallUpdates ?? -1}</Text>
      <Text>tool:{call?.lastToolName ?? "none"}</Text>
      <Text>activity:{call?.lastActivityAt ?? -1}</Text>
      <Text>in:{inputTokens}</Text>
      <Text>out:{outputTokens}</Text>
    </Box>
  );
}

/** Mounts the hook over a fresh bus and returns handles for emitting and draining. */
function mount(options: { bus?: IAgentStreamEventBus | null } = {}) {
  const bus = "bus" in options ? options.bus : new AgentStreamEventBus();
  const view = render(<HookOutput bus={bus} />);

  const emit = (...events: AgentStreamEvent[]) => {
    act(() => {
      for (const event of events) bus?.emitAgentStream(event);
    });
  };

  /**
   * Waits past one drain tick so the buffered refs reach React state.
   *
   * `act` returns React's own `Thenable`, not a `Promise`, which trips
   * biome's useAwaitThenable — hence the `Promise.resolve` wrapper rather
   * than awaiting the call directly.
   */
  const drain = async () => {
    await Promise.resolve(
      act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_WAIT_MS));
      }),
    );
  };

  return { ...view, bus, emit, drain };
}

describe("useAgentStreamEvents — call lifecycle", () => {
  test("starts with no calls and zero tokens", () => {
    const { lastFrame, unmount } = mount();

    expect(lastFrame()).toContain("calls:0");
    expect(lastFrame()).toContain("in:0");
    expect(lastFrame()).toContain("out:0");
    unmount();
  });

  test("agent.call_started records the call with its agent, model, story and stage", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(started());
    await drain();

    expect(lastFrame()).toContain("calls:1");
    expect(lastFrame()).toContain("agent:claude");
    expect(lastFrame()).toContain("model:claude-opus-5");
    expect(lastFrame()).toContain("story:US-001");
    expect(lastFrame()).toContain("stage:execution");
    expect(lastFrame()).toContain("status:active");
    unmount();
  });

  test("a new call starts every counter at zero", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(started());
    await drain();

    expect(lastFrame()).toContain("msg:0");
    expect(lastFrame()).toContain("think:0");
    expect(lastFrame()).toContain("usage:0");
    expect(lastFrame()).toContain("tools:0");
    unmount();
  });

  test("agent.call_ended removes the call", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(started(), update("agent.call_ended", { status: "success" }));
    await drain();

    expect(lastFrame()).toContain("calls:0");
    unmount();
  });
});

describe("useAgentStreamEvents — per-kind counters", () => {
  test("agent.message_update increments messageUpdates and advances lastActivityAt", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(started(), update("agent.message_update"), update("agent.message_update"));
    await drain();

    expect(lastFrame()).toContain("msg:2");
    expect(lastFrame()).toContain("activity:2000");
    unmount();
  });

  test("agent.thinking_update increments thinkingUpdates", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(started(), update("agent.thinking_update"));
    await drain();

    expect(lastFrame()).toContain("think:1");
    unmount();
  });

  test("agent.tool_call_update increments toolCallUpdates and records the tool name", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(
      started(),
      update("agent.tool_call_update", { toolName: "Read" }),
      update("agent.tool_call_update", { toolName: "Edit" }),
    );
    await drain();

    expect(lastFrame()).toContain("tools:2");
    expect(lastFrame()).toContain("tool:Edit");
    unmount();
  });

  test("an update for an unknown call is ignored", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(update("agent.message_update", { callId: "call-unknown" }));
    await drain();

    expect(lastFrame()).toContain("calls:0");
    unmount();
  });

  test("agent.process_update carries no per-call state and changes nothing", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(started(), update("agent.process_update", { status: "spawned" }));
    await drain();

    expect(lastFrame()).toContain("msg:0");
    expect(lastFrame()).toContain("activity:1000");
    unmount();
  });
});

describe("useAgentStreamEvents — token totals are cumulative-to-delta", () => {
  test("the first usage_update adds its totals whole", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(started(), update("agent.usage_update", { inputTokens: 100, outputTokens: 40 }));
    await drain();

    expect(lastFrame()).toContain("in:100");
    expect(lastFrame()).toContain("out:40");
    expect(lastFrame()).toContain("usage:1");
    unmount();
  });

  test("a later cumulative total adds only the delta, not the total again", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(
      started(),
      update("agent.usage_update", { inputTokens: 100, outputTokens: 40 }),
      update("agent.usage_update", { inputTokens: 150, outputTokens: 90 }),
    );
    await drain();

    expect(lastFrame()).toContain("in:150");
    expect(lastFrame()).toContain("out:90");
    unmount();
  });

  test("a total that goes backwards never decreases the running count", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(
      started(),
      update("agent.usage_update", { inputTokens: 100, outputTokens: 40 }),
      update("agent.usage_update", { inputTokens: 10, outputTokens: 5 }),
    );
    await drain();

    expect(lastFrame()).toContain("in:100");
    expect(lastFrame()).toContain("out:40");
    unmount();
  });

  test("a usage_update omitting token fields leaves the totals untouched", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(started(), update("agent.usage_update", { inputTokens: 100 }), update("agent.usage_update"));
    await drain();

    expect(lastFrame()).toContain("in:100");
    expect(lastFrame()).toContain("out:0");
    expect(lastFrame()).toContain("usage:2");
    unmount();
  });

  test("a call that ends and restarts counts its new totals from zero again", async () => {
    const { lastFrame, emit, drain, unmount } = mount();

    emit(
      started(),
      update("agent.usage_update", { inputTokens: 100, outputTokens: 40 }),
      update("agent.call_ended", { status: "success" }),
      started(),
      update("agent.usage_update", { inputTokens: 30, outputTokens: 10 }),
    );
    await drain();

    expect(lastFrame()).toContain("in:130");
    expect(lastFrame()).toContain("out:50");
    unmount();
  });
});

describe("useAgentStreamEvents — no bus", () => {
  test("a null bus leaves the hook inert rather than throwing", async () => {
    const { lastFrame, drain, unmount } = mount({ bus: null });

    await drain();

    expect(lastFrame()).toContain("calls:0");
    expect(lastFrame()).toContain("in:0");
    unmount();
  });
});
