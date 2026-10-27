import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { reduceTranscript, type TranscriptEntry } from "@/tui/chat/transcript-model";

const AT = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-01T00:00:04.000Z";
const LATEST = "2026-10-01T00:00:09.000Z";

interface EventOptions {
  readonly turnId?: string;
  readonly at?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

function base(options: EventOptions = {}) {
  return {
    sessionId: "s1",
    turnId: options.turnId ?? "t1",
    at: options.at ?? AT,
    metadata: options.metadata ?? {},
  };
}

function textDelta(text: string, options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "text_delta", round: 1, text };
}

function thinkingDelta(text: string, options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "thinking_delta", round: 1, text };
}

function toolCall(
  options: EventOptions & { readonly callId?: string; readonly name?: string; readonly input?: unknown } = {},
): SessionEvent {
  return {
    ...base(options),
    type: "tool_call",
    callId: options.callId ?? "c1",
    name: options.name ?? "Read",
    input: "input" in options ? options.input : { path: "a.ts" },
  };
}

function toolResult(
  options: EventOptions & { readonly callId?: string; readonly isError?: boolean; readonly preview?: string } = {},
): SessionEvent {
  return {
    ...base(options),
    type: "tool_result",
    callId: options.callId ?? "c1",
    isError: options.isError ?? false,
    preview: options.preview ?? "",
  };
}

function turnEnd(
  options: EventOptions & {
    readonly status?: "completed" | "cancelled" | "errored";
    readonly error?: { readonly code: string; readonly message: string };
  } = {},
): SessionEvent {
  return {
    ...base(options),
    type: "turn_end",
    status: options.status ?? "completed",
    output: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    ...(options.error ? { error: options.error } : {}),
  };
}

/** An agent-run call: the `nax-agents` provider's `run` tool, whose input carries the task. */
const AGENT_RUN = { name: "nax-agents__run", input: { agent: "reviewer", task: "scan" } } as const;

function reduce(...events: readonly SessionEvent[]): readonly TranscriptEntry[] {
  return events.reduce<readonly TranscriptEntry[]>((entries, event) => reduceTranscript(entries, event), []);
}

describe("reduceTranscript text deltas", () => {
  test("appends the second text delta of a turn to the last reply", () => {
    const entries = reduce(textDelta("Hel", { turnId: "t1" }), textDelta("lo", { turnId: "t1" }));
    expect(entries).toEqual([{ kind: "reply", turnId: "t1", text: "Hello" }]);
  });

  test("adds a second reply when the turn changes", () => {
    const entries = reduce(textDelta("one", { turnId: "t1" }), textDelta("two", { turnId: "t2" }));
    expect(entries).toEqual([
      { kind: "reply", turnId: "t1", text: "one" },
      { kind: "reply", turnId: "t2", text: "two" },
    ]);
  });

  test("adds a new reply when the last entry is a tool of the same turn", () => {
    const entries = reduce(textDelta("one", { turnId: "t1" }), toolCall({ callId: "c1" }), textDelta("two"));
    expect(entries).toEqual([
      { kind: "reply", turnId: "t1", text: "one" },
      {
        kind: "tool",
        turnId: "t1",
        callId: "c1",
        name: "Read",
        input: { path: "a.ts" },
        startedAt: AT,
        status: "running",
        children: [],
      },
      { kind: "reply", turnId: "t1", text: "two" },
    ]);
  });
});

describe("reduceTranscript thinking deltas", () => {
  test("folds two thinking deltas of one turn into a single entry", () => {
    const entries = reduce(thinkingDelta("a", { at: AT }), thinkingDelta("b", { at: LATER }));
    expect(entries).toEqual([{ kind: "thinking", turnId: "t1", text: "ab", startedAt: AT }]);
  });

  test("starts the thinking entry at the first delta's at", () => {
    const entries = reduce(thinkingDelta("a", { at: AT }), thinkingDelta("b", { at: LATER }));
    expect(entries[0]).toMatchObject({ kind: "thinking", startedAt: AT });
  });
});

describe("reduceTranscript thinking ends", () => {
  test("ends the open thinking entry when a tool call of the turn arrives", () => {
    const entries = reduce(thinkingDelta("a", { at: AT }), toolCall({ at: LATER }));
    expect(entries[0]).toEqual({ kind: "thinking", turnId: "t1", text: "a", startedAt: AT, endedAt: LATER });
  });

  test("ends the open thinking entry when the turn ends", () => {
    const entries = reduce(thinkingDelta("a", { at: AT }), turnEnd({ at: LATEST }));
    expect(entries[0]).toEqual({ kind: "thinking", turnId: "t1", text: "a", startedAt: AT, endedAt: LATEST });
  });
});

describe("reduceTranscript tool calls", () => {
  test("adds a running tool entry carrying the call's identity and input", () => {
    const entries = reduce(toolCall({ callId: "c1", name: "Read", input: { path: "a.ts" } }));
    expect(entries).toEqual([
      {
        kind: "tool",
        turnId: "t1",
        callId: "c1",
        name: "Read",
        input: { path: "a.ts" },
        startedAt: AT,
        status: "running",
        children: [],
      },
    ]);
  });

  test("starts the tool entry at the event's at", () => {
    const entries = reduce(toolCall({ at: LATER }));
    expect(entries[0]).toMatchObject({ kind: "tool", startedAt: LATER });
  });
});

describe("reduceTranscript tool results", () => {
  test("marks the matching entry ok and keeps the result's preview", () => {
    const entries = reduce(toolCall({ callId: "c1" }), toolResult({ callId: "c1", isError: false, preview: "x" }));
    expect(entries[0]).toMatchObject({ kind: "tool", status: "ok", preview: "x" });
  });

  test("ends the matching entry at the result's at", () => {
    const entries = reduce(toolCall({ callId: "c1" }), toolResult({ callId: "c1", at: LATER }));
    expect(entries[0]).toMatchObject({ kind: "tool", endedAt: LATER });
  });

  test("marks the matching entry error when the result is an error", () => {
    const entries = reduce(toolCall({ callId: "c1" }), toolResult({ callId: "c1", isError: true }));
    expect(entries[0]).toMatchObject({ kind: "tool", status: "error" });
  });

  test("returns the input array unchanged when no entry matches the call", () => {
    const before = reduce(toolCall({ callId: "c1" }));
    const after = reduceTranscript(before, toolResult({ callId: "c9" }));
    expect(after).toBe(before);
  });
});

describe("reduceTranscript subagent calls", () => {
  test("adds no top-level entry for a call tagged with a running agent's task", () => {
    const entries = reduce(
      toolCall({ callId: "a1", ...AGENT_RUN }),
      toolCall({ callId: "c2", metadata: { subagentTask: "scan" } }),
    );
    expect(entries).toHaveLength(1);
  });

  test("appends a call tagged with a running agent's task to that agent's children", () => {
    const entries = reduce(
      toolCall({ callId: "a1", ...AGENT_RUN }),
      toolCall({ callId: "c2", name: "Read", metadata: { subagentTask: "scan" } }),
    );
    expect(entries[0]).toMatchObject({
      kind: "tool",
      children: [{ callId: "c2", name: "Read", input: { path: "a.ts" }, status: "running" }],
    });
  });

  test("marks the tagged child ok on a result carrying its call", () => {
    const entries = reduce(
      toolCall({ callId: "a1", ...AGENT_RUN }),
      toolCall({ callId: "c2", metadata: { subagentTask: "scan" } }),
      toolResult({ callId: "c2", metadata: { subagentTask: "scan" }, at: LATER }),
    );
    expect(entries[0]).toMatchObject({ kind: "tool", children: [{ callId: "c2", status: "ok" }] });
  });

  test("adds a top-level tool entry when no running agent has the tagged task", () => {
    const entries = reduce(
      toolCall({ callId: "a1", ...AGENT_RUN }),
      toolCall({ callId: "c2", metadata: { subagentTask: "other" } }),
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      kind: "tool",
      turnId: "t1",
      callId: "c2",
      name: "Read",
      input: { path: "a.ts" },
      startedAt: AT,
      status: "running",
      children: [],
    });
  });
});

describe("reduceTranscript turn end", () => {
  test("adds an error entry when the turn ended errored", () => {
    const entries = reduce(turnEnd({ status: "errored", error: { code: "X", message: "broke" } }));
    expect(entries).toEqual([{ kind: "error", text: "X: broke" }]);
  });

  test("adds an interrupted entry when the turn ended cancelled", () => {
    const entries = reduce(turnEnd({ status: "cancelled" }));
    expect(entries).toEqual([{ kind: "interrupted" }]);
  });
});

describe("reduceTranscript compaction", () => {
  test("adds the compaction notice", () => {
    const entries = reduce({
      sessionId: "s1",
      turnId: "t1",
      at: AT,
      metadata: {},
      type: "compaction",
      reason: "proactive",
    });
    expect(entries).toEqual([{ kind: "notice", text: "conversation compacted" }]);
  });
});

describe("reduceTranscript immutability", () => {
  test("keeps every earlier entry identical when a delta extends the last reply", () => {
    const first = reduce(toolCall({ callId: "c1" }));
    const second = reduceTranscript(first, textDelta("one"));
    const third = reduceTranscript(second, textDelta("two"));
    expect(third).toHaveLength(2);
    expect(third[0]).toBe(first[0]);
    expect(third[0]).toBe(second[0]);
    expect(third[1]).not.toBe(second[1]);
    expect(third[1]).toEqual({ kind: "reply", turnId: "t1", text: "onetwo" });
  });

  test("returns the input array unchanged for an event it ignores", () => {
    const before = reduce(textDelta("one"));
    const after = reduceTranscript(before, {
      sessionId: "s1",
      turnId: "t1",
      at: LATER,
      metadata: {},
      type: "usage",
      round: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });
    expect(after).toBe(before);
  });
});
