import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { formatTokens, IDLE_STATUS, reduceTurnStatus, shortModel, type TurnStatus } from "@/tui/chat/chat-status";

const AT = "2026-10-26T00:00:00.000Z";
const LATER = "2026-10-26T00:00:04.000Z";

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

function turnStart(options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "turn_start" };
}

function thinkingDelta(text: string, options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "thinking_delta", round: 1, text };
}

function textDelta(text: string, options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "text_delta", round: 1, text };
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

function toolResult(options: EventOptions & { readonly callId?: string } = {}): SessionEvent {
  return { ...base(options), type: "tool_result", callId: options.callId ?? "c1", isError: false, preview: "" };
}

function approvalRequested(
  options: EventOptions & { readonly requestId?: string; readonly answerable?: false } = {},
): SessionEvent {
  return {
    ...base(options),
    type: "approval_requested",
    requestId: options.requestId ?? "r1",
    tool: "Write",
    summary: "write a.ts",
    reason: "outside the workdir",
    expiresAt: AT,
    ...(options.answerable === undefined ? {} : { answerable: options.answerable }),
  };
}

function approvalResolved(options: EventOptions & { readonly requestId?: string } = {}): SessionEvent {
  return {
    ...base(options),
    type: "approval_resolved",
    requestId: options.requestId ?? "r1",
    decision: "allow",
    decidedBy: "human",
  };
}

function compaction(options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "compaction", reason: "proactive" };
}

function streamReset(options: EventOptions = {}): SessionEvent {
  return { ...base(options), type: "stream_reset", round: 1, attempt: 2 };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  options: EventOptions & { readonly cacheRead?: number; readonly cacheWrite?: number } = {},
): SessionEvent {
  return {
    ...base(options),
    type: "usage",
    round: 1,
    inputTokens,
    outputTokens,
    costUsd: 0.1,
    ...(options.cacheRead === undefined ? {} : { cacheRead: options.cacheRead }),
    ...(options.cacheWrite === undefined ? {} : { cacheWrite: options.cacheWrite }),
  };
}

function turnEnd(options: EventOptions = {}): SessionEvent {
  return {
    ...base(options),
    type: "turn_end",
    status: "completed",
    output: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
  };
}

/** A status mid-turn in the tool phase, so "unchanged" assertions have something to lose. */
const TOOL_STATUS: TurnStatus = {
  running: true,
  startedAt: AT,
  phase: "tool",
  toolName: "Bash",
  inputTokens: 7,
  outputTokens: 3,
};

describe("reduceTurnStatus turn start", () => {
  test("starts the turn in the thinking phase at the event's at", () => {
    const status = reduceTurnStatus(IDLE_STATUS, turnStart({ at: AT }));
    expect(status).toEqual({ running: true, startedAt: AT, phase: "thinking", inputTokens: 0, outputTokens: 0 });
  });

  test("reports running and the event's startedAt", () => {
    const status = reduceTurnStatus(IDLE_STATUS, turnStart({ at: AT }));
    expect(status.running).toBe(true);
    expect(status.phase).toBe("thinking");
    expect(status.startedAt).toBe(AT);
  });

  test("resets the token sums of a previous turn", () => {
    const used = reduceTurnStatus(TOOL_STATUS, usage(100, 10));
    const status = reduceTurnStatus(used, turnStart({ at: LATER }));
    expect(status.inputTokens).toBe(0);
    expect(status.outputTokens).toBe(0);
  });
});

describe("reduceTurnStatus phases", () => {
  test("sets writing on a text delta", () => {
    expect(reduceTurnStatus(TOOL_STATUS, textDelta("hi")).phase).toBe("writing");
  });

  test("sets thinking on a thinking delta", () => {
    expect(reduceTurnStatus(TOOL_STATUS, thinkingDelta("hmm")).phase).toBe("thinking");
  });

  test("sets tool and the call's name on a tool call", () => {
    const status = reduceTurnStatus(IDLE_STATUS, toolCall({ name: "Bash" }));
    expect(status.phase).toBe("tool");
    expect(status.toolName).toBe("Bash");
  });

  test("sets thinking on a tool result", () => {
    expect(reduceTurnStatus(TOOL_STATUS, toolResult({ callId: "c1" })).phase).toBe("thinking");
  });

  test("sets approval on an approval request", () => {
    expect(reduceTurnStatus(TOOL_STATUS, approvalRequested()).phase).toBe("approval");
  });

  test("leaves the phase unchanged on an unanswerable approval request", () => {
    const status = reduceTurnStatus(TOOL_STATUS, approvalRequested({ answerable: false }));
    expect(status.phase).toBe("tool");
  });

  test("sets thinking once an approval resolves", () => {
    const asked = reduceTurnStatus(TOOL_STATUS, approvalRequested());
    expect(reduceTurnStatus(asked, approvalResolved()).phase).toBe("thinking");
  });

  test("sets compacting on a compaction", () => {
    expect(reduceTurnStatus(TOOL_STATUS, compaction()).phase).toBe("compacting");
  });

  test("sets retrying on a stream reset", () => {
    expect(reduceTurnStatus(TOOL_STATUS, streamReset()).phase).toBe("retrying");
  });
});

describe("reduceTurnStatus usage", () => {
  test("adds the input and output tokens of two usage events", () => {
    const first = reduceTurnStatus(IDLE_STATUS, usage(100, 10));
    const status = reduceTurnStatus(first, usage(200, 20));
    expect(status.inputTokens).toBe(300);
    expect(status.outputTokens).toBe(30);
  });

  test("sets contextTokens to input plus cache read and cache write", () => {
    const status = reduceTurnStatus(IDLE_STATUS, usage(100, 10, { cacheRead: 50, cacheWrite: 5 }));
    expect(status.contextTokens).toBe(155);
  });
});

describe("reduceTurnStatus turn end", () => {
  test("stops the turn", () => {
    const running = reduceTurnStatus(IDLE_STATUS, turnStart({ at: AT }));
    expect(reduceTurnStatus(running, turnEnd()).running).toBe(false);
  });

  test("keeps the context token count", () => {
    const used = reduceTurnStatus(IDLE_STATUS, usage(100, 10, { cacheRead: 50, cacheWrite: 5 }));
    expect(reduceTurnStatus(used, turnEnd()).contextTokens).toBe(155);
  });
});

describe("reduceTurnStatus subagent events", () => {
  test("returns the status unchanged for a call tagged with a running agent's task", () => {
    const before = reduceTurnStatus(IDLE_STATUS, turnStart({ at: AT }));
    const status = reduceTurnStatus(before, toolCall({ name: "Bash", metadata: { subagentTask: "scan" } }));
    expect(status).toBe(before);
  });
});

describe("formatTokens", () => {
  test("returns the integer below a thousand", () => {
    expect(formatTokens(999)).toBe("999");
  });

  test("returns one decimal and k from a thousand up", () => {
    expect(formatTokens(1234)).toBe("1.2k");
  });

  test("switches to k exactly at a thousand", () => {
    expect(formatTokens(1000)).toBe("1.0k");
  });
});

describe("shortModel", () => {
  test("returns the text after the last slash", () => {
    expect(shortModel("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });

  test("elides a name longer than 24 characters to 23 and an ellipsis", () => {
    const model = "abcdefghijklmnopqrstuvwxyz1234";
    expect(model).toHaveLength(30);
    expect(shortModel(model)).toBe(`${model.slice(0, 23)}…`);
  });

  test("keeps a name of exactly 24 characters whole", () => {
    const model = "abcdefghijklmnopqrstuvwx";
    expect(model).toHaveLength(24);
    expect(shortModel(model)).toBe(model);
  });
});
