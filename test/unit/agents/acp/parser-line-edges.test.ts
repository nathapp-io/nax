/**
 * Characterisation tests for parseAcpxJsonLine branches nothing else pins
 * (written against the unrefactored parser, before the B3 complexity drain).
 * The parser refactor must keep every assertion in this file green unchanged.
 *
 * Covered here because the mirror suites (parser.test.ts, activity-emission.test.ts)
 * leave these arms unpinned: the first-JSON-line fallback purge, drift-guard
 * log/error interplay, session/update guard arms, the update.used fallback,
 * snake_case stop_reason, JSON-RPC error diagnostics, legacy string errors,
 * legacy stop-reason capture, and tool-name resolution edges.
 */

import { describe, expect, test } from "bun:test";
import { createParseState, finalizeParseState, parseAcpxJsonLine } from "@/agents";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

// ── wire-line builders (same local pattern parser.test.ts uses) ──────────────

function sessionUpdateLine(update: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "x", update },
  });
}

function messageChunkLine(text: string): string {
  return sessionUpdateLine({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

function driftedMethodLine(): string {
  return JSON.stringify({
    jsonrpc: "1.0",
    method: "session/update",
    params: {
      sessionId: "x",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "should not leak" } },
    },
  });
}

function jsonRpcResultLine(result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
}

function jsonRpcErrorLine(error: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, error });
}

// ── first-JSON-line fallback purge ───────────────────────────────────────────

describe("parseAcpxJsonLine — first-JSON-line fallback purge", () => {
  test("a stashed legacy-text fallback is dropped when the first valid NDJSON line arrives", () => {
    const state = createParseState();
    // An unparseable banner/reconnect-notice line stashes itself as fallback text.
    parseAcpxJsonLine("reconnecting to acpx daemon", state);
    expect(state.text).toBe("reconnecting to acpx daemon");
    // The first real NDJSON line must purge that stash so it cannot become a
    // permanent prefix of the response.
    parseAcpxJsonLine(messageChunkLine("hello"), state);
    expect(finalizeParseState(state).text).toBe("hello");
  });

  test("an unparseable line is not stashed once any JSON line has been seen, even with empty text", () => {
    const state = createParseState();
    // A parseable but text-less line flips sawJsonLine without touching text.
    parseAcpxJsonLine(jsonRpcResultLine({ stopReason: "end_turn" }), state);
    expect(state.sawJsonLine).toBe(true);
    parseAcpxJsonLine("stray banner", state);
    expect(state.text).toBe("");
  });
});

// ── drift-guard error/log interplay (BUG-53 edges the mirror does not pin) ───

describe("parseAcpxJsonLine — drift guard error and log interplay", () => {
  test("the drift guard does not overwrite an error captured by an earlier line", () => {
    const state = createParseState();
    parseAcpxJsonLine(JSON.stringify({ error: { message: "auth failed" } }), state);
    const activity = parseAcpxJsonLine(driftedMethodLine(), state);
    expect(activity).toBeUndefined();
    expect(finalizeParseState(state).error).toBe("auth failed");
  });

  test("a drifted method/params line logs the unsupported version with the wire method name", () => {
    const logCalls: LogEntry[] = [];
    initLogger({ level: "silent" });
    const removeSink = addSink((entry) => logCalls.push(entry));
    try {
      const state = createParseState();
      const activity = parseAcpxJsonLine(driftedMethodLine(), state);
      expect(activity).toBeUndefined();
      expect(state.error).toBe("Unsupported acpx JSON-RPC protocol version");
      const entry = logCalls.find((l) => l.message.includes("Unsupported or missing JSON-RPC protocol version"));
      expect(entry).toBeDefined();
      expect(entry?.level).toBe("error");
      expect(entry?.stage).toBe("acp-adapter");
      expect(entry?.data?.jsonrpc).toBe("1.0");
      expect(entry?.data?.method).toBe("session/update");
    } finally {
      removeSink();
      resetLogger();
    }
  });

  test("a drifted id/result line logs no method name", () => {
    const logCalls: LogEntry[] = [];
    initLogger({ level: "silent" });
    const removeSink = addSink((entry) => logCalls.push(entry));
    try {
      parseAcpxJsonLine(JSON.stringify({ id: 5, result: { stopReason: "end_turn" } }), createParseState());
      const entry = logCalls.find((l) => l.message.includes("Unsupported or missing JSON-RPC protocol version"));
      expect(entry).toBeDefined();
      expect(entry?.data?.jsonrpc).toBeUndefined();
      expect(entry?.data?.method).toBeUndefined();
    } finally {
      removeSink();
      resetLogger();
    }
  });
});

// ── session/update guard arms ────────────────────────────────────────────────

describe("parseAcpxJsonLine — session/update guard arms", () => {
  test("a message chunk with non-text content emits no activity and accumulates nothing", () => {
    const state = createParseState();
    const activity = parseAcpxJsonLine(
      sessionUpdateLine({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "base64data" } }),
      state,
    );
    expect(activity).toBeUndefined();
    expect(state.text).toBe("");
  });

  test("an unknown sessionUpdate value emits no activity and changes no state", () => {
    const state = createParseState();
    const activity = parseAcpxJsonLine(sessionUpdateLine({ sessionUpdate: "plan_update", plan: "..." }), state);
    expect(activity).toBeUndefined();
    expect(state.text).toBe("");
    expect(finalizeParseState(state).error).toBeUndefined();
  });

  test("an unknown sessionUpdate on a line that also carries result and error falls through to both", () => {
    // handleJsonRpcEvent only returns early when handleSessionUpdate yields an
    // activity; an unrecognised update must still reach the result and error
    // appliers on the same line.
    const state = createParseState();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/update",
      params: { sessionId: "x", update: { sessionUpdate: "plan_update", plan: "..." } },
      result: { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 22 } },
      error: { code: -32000, message: "fell through to the error arm" },
    });

    expect(parseAcpxJsonLine(line, state)).toBeUndefined();
    expect(state.stopReason).toBe("end_turn");
    expect(state.tokenUsage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(state.error).toContain("fell through to the error arm");
  });

  test("a session/update without params.update emits no activity", () => {
    const state = createParseState();
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "x" } });
    expect(parseAcpxJsonLine(line, state)).toBeUndefined();
  });
});

// ── usage_update fallback to update.used ─────────────────────────────────────

describe("parseAcpxJsonLine — usage_update used-fallback", () => {
  test("output tokens fall back to update.used when no _meta breakdown exists", () => {
    const activity = parseAcpxJsonLine(
      sessionUpdateLine({ sessionUpdate: "usage_update", used: 321 }),
      createParseState(),
    );
    expect(activity?.kind).toBe("usage_update");
    expect(activity?.outputTokens).toBe(321);
    expect(activity?.inputTokens).toBeUndefined();
  });

  test("a non-object _meta is ignored and the used fallback still applies", () => {
    const activity = parseAcpxJsonLine(
      sessionUpdateLine({ sessionUpdate: "usage_update", _meta: "junk", used: 5 }),
      createParseState(),
    );
    expect(activity?.outputTokens).toBe(5);
  });
});

// ── final-result details ─────────────────────────────────────────────────────

describe("parseAcpxJsonLine — final result details", () => {
  test("snake_case stop_reason is captured and wins when both spellings appear", () => {
    const snakeOnly = createParseState();
    parseAcpxJsonLine(jsonRpcResultLine({ stop_reason: "end_turn" }), snakeOnly);
    expect(finalizeParseState(snakeOnly).stopReason).toBe("end_turn");

    const both = createParseState();
    parseAcpxJsonLine(jsonRpcResultLine({ stopReason: "camel", stop_reason: "snake" }), both);
    expect(finalizeParseState(both).stopReason).toBe("snake");
  });

  test("a non-object result.usage is skipped while stopReason is still captured", () => {
    const state = createParseState();
    parseAcpxJsonLine(jsonRpcResultLine({ stopReason: "end_turn", usage: "junk" }), state);
    const result = finalizeParseState(state);
    expect(result.stopReason).toBe("end_turn");
    expect(result.tokenUsage).toBeUndefined();
  });
});

// ── JSON-RPC error-response details ──────────────────────────────────────────

describe("parseAcpxJsonLine — JSON-RPC error-response details", () => {
  test("a non-string error message stringifies the whole error object", () => {
    const state = createParseState();
    parseAcpxJsonLine(jsonRpcErrorLine({ code: -32601 }), state);
    expect(finalizeParseState(state).error).toBe('{"code":-32601}');
  });

  test("the acpxCode/detailCode suffix joins both codes", () => {
    const state = createParseState();
    parseAcpxJsonLine(jsonRpcErrorLine({ message: "boom", data: { acpxCode: "ACX", detailCode: "D9" } }), state);
    expect(finalizeParseState(state).error).toBe("boom [ACX/D9]");
  });

  test("the first JSON-RPC error wins and a later retryable flag is ignored once an error exists", () => {
    const state = createParseState();
    parseAcpxJsonLine(jsonRpcErrorLine({ message: "first failure", data: { retryable: false } }), state);
    parseAcpxJsonLine(jsonRpcErrorLine({ message: "second failure", data: { retryable: true } }), state);
    const result = finalizeParseState(state);
    expect(result.error).toBe("first failure");
    expect(result.retryable).toBe(false);
  });
});

// ── legacy flat-NDJSON details ───────────────────────────────────────────────

describe("parseAcpxJsonLine — legacy flat NDJSON details", () => {
  test("a legacy string error is captured verbatim", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"error":"boom"}', state);
    expect(finalizeParseState(state).error).toBe("boom");
  });

  test("a legacy string error never overwrites an earlier object error", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"error":{"message":"first"}}', state);
    parseAcpxJsonLine('{"error":"second"}', state);
    expect(finalizeParseState(state).error).toBe("first");
  });

  test("non-string result/content/text values change nothing", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"result":42,"content":null,"text":true}', state);
    expect(state.text).toBe("");
  });

  test("legacy stopReason and stop_reason are captured", () => {
    const camel = createParseState();
    parseAcpxJsonLine('{"stopReason":"max_tokens"}', camel);
    expect(finalizeParseState(camel).stopReason).toBe("max_tokens");

    const snake = createParseState();
    parseAcpxJsonLine('{"stop_reason":"end_turn"}', snake);
    expect(finalizeParseState(snake).stopReason).toBe("end_turn");
  });
});

// ── tool-name resolution edges ───────────────────────────────────────────────

describe("parseAcpxJsonLine — tool-name resolution edges", () => {
  test("a whitespace-only direct toolName falls through to the nested tool.name", () => {
    const activity = parseAcpxJsonLine(
      sessionUpdateLine({ sessionUpdate: "tool_call", toolName: "   ", tool: { name: "bash" } }),
      createParseState(),
    );
    expect(activity).toEqual({ kind: "tool_call_update", toolName: "bash" });
  });

  test("a tool_call with no usable name emits the activity with toolName undefined", () => {
    const activity = parseAcpxJsonLine(sessionUpdateLine({ sessionUpdate: "tool_call_update" }), createParseState());
    expect(activity).toEqual({ kind: "tool_call_update", toolName: undefined });
  });
});
