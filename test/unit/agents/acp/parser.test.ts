import { describe, expect, test } from "bun:test";
import { createParseState, finalizeParseState, parseAcpxJsonLine, parseAcpxJsonOutput } from "@/agents";

// Real acpx JSON-RPC envelope format (captured from live acpx v0.3.0)
const REAL_ACPX_OUTPUT = [
  '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}',
  '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"usage_update","used":24848,"size":200000,"cost":{"amount":0.15539,"currency":"USD"}}}}',
  '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn","usage":{"inputTokens":3,"outputTokens":4,"cachedReadTokens":0,"cachedWriteTokens":24844,"totalTokens":24851}}}',
].join("\n");

describe("parseAcpxJsonOutput — JSON-RPC envelope format", () => {
  test("extracts text from agent_message_chunk", () => {
    const result = parseAcpxJsonOutput(REAL_ACPX_OUTPUT);
    expect(result.text).toBe("hello");
  });

  test("captures exact cost from usage_update", () => {
    const result = parseAcpxJsonOutput(REAL_ACPX_OUTPUT);
    expect(result.exactCostUsd).toBe(0.15539);
  });

  test("captures token breakdown (camelCase) from final result", () => {
    const result = parseAcpxJsonOutput(REAL_ACPX_OUTPUT);
    expect(result.tokenUsage).toEqual({
      input_tokens: 3,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 24844,
    });
  });

  test("captures stopReason from final result", () => {
    const result = parseAcpxJsonOutput(REAL_ACPX_OUTPUT);
    expect(result.stopReason).toBe("end_turn");
  });

  test("accumulates multi-chunk text", () => {
    const output = [
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"foo "}}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"bar"}}}}',
      '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn","usage":{"inputTokens":5,"outputTokens":2,"cachedReadTokens":0,"cachedWriteTokens":0}}}',
    ].join("\n");
    const result = parseAcpxJsonOutput(output);
    expect(result.text).toBe("foo bar");
  });

  test("returns undefined exactCostUsd when no usage_update", () => {
    const output =
      '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":1,"cachedReadTokens":0,"cachedWriteTokens":0}}}';
    const result = parseAcpxJsonOutput(output);
    expect(result.exactCostUsd).toBeUndefined();
  });

  test("returns undefined tokenUsage when no result", () => {
    const output =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}';
    const result = parseAcpxJsonOutput(output);
    expect(result.tokenUsage).toBeUndefined();
    expect(result.text).toBe("hi");
  });
});

describe("parseAcpxJsonOutput — legacy flat NDJSON format", () => {
  test("still parses legacy result string", () => {
    const output = '{"result":"legacy output"}';
    const result = parseAcpxJsonOutput(output);
    expect(result.text).toBe("legacy output");
  });

  test("still parses legacy snake_case token usage", () => {
    const output = '{"usage":{"input_tokens":100,"output_tokens":50}}';
    const result = parseAcpxJsonOutput(output);
    expect(result.tokenUsage?.input_tokens).toBe(100);
    expect(result.tokenUsage?.output_tokens).toBe(50);
  });

  // The legacy NDJSON branch treats result/content/text as mutually exclusive
  // per event (see parser.ts comment). These tests pin that contract so a future
  // refactor away from else-if is caught.
  test("legacy content chunk accumulates", () => {
    const result = parseAcpxJsonOutput('{"content":"foo"}\n{"content":"bar"}');
    expect(result.text).toBe("foobar");
  });

  test("legacy text chunk accumulates (older field name)", () => {
    const result = parseAcpxJsonOutput('{"text":"foo"}\n{"text":"bar"}');
    expect(result.text).toBe("foobar");
  });

  test("legacy result resets accumulated text (final full text wins)", () => {
    const result = parseAcpxJsonOutput('{"content":"partial"}\n{"result":"final"}');
    expect(result.text).toBe("final");
  });

  test("within one event, result wins over content and text", () => {
    const result = parseAcpxJsonOutput('{"result":"R","content":"C","text":"T"}');
    expect(result.text).toBe("R");
  });

  test("within one event, content wins over text", () => {
    const result = parseAcpxJsonOutput('{"content":"C","text":"T"}');
    expect(result.text).toBe("C");
  });
});

describe("incremental API — createParseState / parseAcpxJsonLine / finalizeParseState", () => {
  const LINES = [
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"usage_update","used":24848,"size":200000,"cost":{"amount":0.15539,"currency":"USD"}}}}',
    '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn","usage":{"inputTokens":3,"outputTokens":4,"cachedReadTokens":0,"cachedWriteTokens":24844}}}',
  ];

  test("produces same result as batch parseAcpxJsonOutput", () => {
    const state = createParseState();
    for (const line of LINES) parseAcpxJsonLine(line, state);
    const incremental = finalizeParseState(state);
    const batch = parseAcpxJsonOutput(LINES.join("\n"));
    expect(incremental).toEqual(batch);
  });

  test("state is empty before any lines are processed", () => {
    const state = createParseState();
    const result = finalizeParseState(state);
    expect(result.text).toBe("");
    expect(result.tokenUsage).toBeUndefined();
    expect(result.exactCostUsd).toBeUndefined();
    expect(result.stopReason).toBeUndefined();
  });

  test("text accumulates across multiple chunk lines", () => {
    const state = createParseState();
    parseAcpxJsonLine(LINES[0], state); // "hello"
    parseAcpxJsonLine(
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" world"}}}}',
      state,
    );
    expect(finalizeParseState(state).text).toBe("hello world");
  });

  test("cost and token fields are captured independently", () => {
    const state = createParseState();
    parseAcpxJsonLine(LINES[1], state); // usage_update
    expect(finalizeParseState(state).exactCostUsd).toBe(0.15539);
    expect(finalizeParseState(state).tokenUsage).toBeUndefined(); // not yet — comes in result line

    parseAcpxJsonLine(LINES[2], state); // result
    const final = finalizeParseState(state);
    expect(final.stopReason).toBe("end_turn");
    expect(final.tokenUsage?.input_tokens).toBe(3);
    expect(final.tokenUsage?.output_tokens).toBe(4);
  });

  test("invalid JSON line is ignored if text already accumulated", () => {
    const state = createParseState();
    parseAcpxJsonLine(LINES[0], state);
    parseAcpxJsonLine("not-json", state);
    expect(finalizeParseState(state).text).toBe("hello");
  });

  test("invalid JSON line used as fallback text when state is empty", () => {
    const state = createParseState();
    parseAcpxJsonLine("bare fallback text", state);
    expect(finalizeParseState(state).text).toBe("bare fallback text");
  });

  test("agent_thought_chunk is NOT accumulated into state.text", () => {
    const state = createParseState();
    const thoughtLine =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"internal reasoning"}}}}';
    const msgLine =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"public answer"}}}}';
    parseAcpxJsonLine(thoughtLine, state);
    parseAcpxJsonLine(msgLine, state);
    const result = finalizeParseState(state);
    // Thought content must NOT appear in the final response text
    expect(result.text).toBe("public answer");
    expect(result.text).not.toContain("internal reasoning");
  });

  test("agent_thought_chunk returns thinking_update activity with deltaBytes", () => {
    const state = createParseState();
    const thoughtLine =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking"}}}}';
    const activity = parseAcpxJsonLine(thoughtLine, state);
    expect(activity?.kind).toBe("thinking_update");
    expect(activity?.deltaBytes).toBe(8); // "thinking".length
  });

  test("tool_call returns tool_call_update activity", () => {
    const state = createParseState();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "tool_call",
          toolName: "bash",
        },
      },
    });
    const activity = parseAcpxJsonLine(line, state);
    expect(activity).toEqual({ kind: "tool_call_update", toolName: "bash" });
  });

  test("tool_call_update returns tool_call_update activity", () => {
    const state = createParseState();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "tool_call_update",
          tool: { name: "read_file" },
        },
      },
    });
    const activity = parseAcpxJsonLine(line, state);
    expect(activity).toEqual({ kind: "tool_call_update", toolName: "read_file" });
  });
});

describe("BUG-53 — protocol-version drift is not silently misparsed as legacy text", () => {
  test("a JSON-RPC-shaped method/params message with a mismatched jsonrpc version is NOT treated as legacy text", () => {
    const state = createParseState();
    const driftedLine = JSON.stringify({
      jsonrpc: "1.0",
      method: "session/update",
      params: {
        sessionId: "x",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "should not leak" } },
      },
    });
    parseAcpxJsonLine(driftedLine, state);
    const result = finalizeParseState(state);
    // Must not have been misparsed into state.text via the legacy branch —
    // legacy expects a top-level string `content`/`text`/`result`, not the
    // nested JSON-RPC params.update shape used here.
    expect(result.text).toBe("");
  });

  test("a JSON-RPC-shaped id/result message with a missing jsonrpc field is NOT treated as legacy text", () => {
    const state = createParseState();
    const driftedLine = JSON.stringify({
      id: 5,
      result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4 } },
    });
    parseAcpxJsonLine(driftedLine, state);
    const result = finalizeParseState(state);
    // The legacy branch only accepts a string `result`; this object-valued
    // result must not silently pass through as accepted legacy content, and
    // stopReason/usage must not be picked up either (no jsonrpc:"2.0").
    expect(result.text).toBe("");
    expect(result.stopReason).toBeUndefined();
  });

  test("genuine legacy flat NDJSON (no method/params, no id+object result/error) still parses normally", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"result":"legacy plain text"}', state);
    expect(finalizeParseState(state).text).toBe("legacy plain text");
  });

  // The drift guard's `id` + object-`error` disjunct overlapped a shape the
  // legacy branch handles correctly (it reads `event.error.message`), so a
  // legacy error response carrying an id had its real failure reason replaced
  // by a bogus protocol-version message. Only object-`result` is genuinely
  // unrepresentable in the legacy branch (which requires a *string* result).
  test("a legacy error response carrying an id surfaces the real error message, not a protocol-drift message", () => {
    const state = createParseState();
    parseAcpxJsonLine(JSON.stringify({ id: 7, error: { message: "model not available" } }), state);
    expect(finalizeParseState(state).error).toBe("model not available");
  });

  test("a legacy error response without an id still surfaces the real error message", () => {
    const state = createParseState();
    parseAcpxJsonLine(JSON.stringify({ error: { message: "auth failed" } }), state);
    expect(finalizeParseState(state).error).toBe("auth failed");
  });

  // Narrowing the guard made the legacy error branch reachable for id-bearing
  // errors, so that branch must extract the same diagnostics the JSON-RPC one
  // does — otherwise `retryable` silently stays false and a retriable failure
  // (QUEUE_DISCONNECTED) is classified as terminal.
  test("a legacy error response carries through retryable and the acpxCode suffix", () => {
    const state = createParseState();
    parseAcpxJsonLine(
      JSON.stringify({
        id: 7,
        error: { message: "queue gone", data: { retryable: true, acpxCode: "QUEUE_DISCONNECTED" } },
      }),
      state,
    );
    const result = finalizeParseState(state);
    expect(result.error).toBe("queue gone [QUEUE_DISCONNECTED]");
    expect(result.retryable).toBe(true);
  });

  test("a legacy error response without a data block leaves retryable false", () => {
    const state = createParseState();
    parseAcpxJsonLine(JSON.stringify({ id: 7, error: { message: "fatal" } }), state);
    const result = finalizeParseState(state);
    expect(result.error).toBe("fatal");
    expect(result.retryable).toBe(false);
  });

  test("an id with an object result is still rejected as protocol drift", () => {
    const state = createParseState();
    parseAcpxJsonLine(JSON.stringify({ id: 5, result: { stopReason: "end_turn" } }), state);
    expect(finalizeParseState(state).error).toBe("Unsupported acpx JSON-RPC protocol version");
  });
});

describe("BUG-54 — partial usage objects do not fabricate zero-filled token usage", () => {
  test("JSON-RPC result usage missing outputTokens leaves tokenUsage undefined", () => {
    const state = createParseState();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { stopReason: "end_turn", usage: { inputTokens: 42 } },
    });
    parseAcpxJsonLine(line, state);
    const result = finalizeParseState(state);
    expect(result.tokenUsage).toBeUndefined();
    // stopReason is unrelated to usage and must still be captured
    expect(result.stopReason).toBe("end_turn");
  });

  test("JSON-RPC result usage missing inputTokens leaves tokenUsage undefined", () => {
    const state = createParseState();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { usage: { outputTokens: 10 } },
    });
    parseAcpxJsonLine(line, state);
    expect(finalizeParseState(state).tokenUsage).toBeUndefined();
  });

  test("JSON-RPC result usage with both required fields still populates tokenUsage", () => {
    const state = createParseState();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { usage: { inputTokens: 3, outputTokens: 4 } },
    });
    parseAcpxJsonLine(line, state);
    const usage = finalizeParseState(state).tokenUsage;
    expect(usage?.input_tokens).toBe(3);
    expect(usage?.output_tokens).toBe(4);
    // Absent cache fields default to 0, not fabricated data on the required fields
    expect(usage?.cache_read_input_tokens).toBe(0);
    expect(usage?.cache_creation_input_tokens).toBe(0);
  });

  test("legacy flat NDJSON usage missing output_tokens leaves tokenUsage undefined", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"usage":{"input_tokens":7}}', state);
    expect(finalizeParseState(state).tokenUsage).toBeUndefined();
  });

  test("legacy flat NDJSON usage with both fields still populates tokenUsage", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"usage":{"input_tokens":7,"output_tokens":9}}', state);
    const usage = finalizeParseState(state).tokenUsage;
    expect(usage?.input_tokens).toBe(7);
    expect(usage?.output_tokens).toBe(9);
  });

  // BUG-59: legacy `event.usage` branch must reject non-finite values the same
  // way every other branch in this file does via asFiniteNumber. A bare
  // `typeof x === "number"` check lets Infinity through uncaught — and acpx
  // CAN emit a syntactically valid JSON number that overflows to Infinity on
  // parse (e.g. an exponent large enough to exceed IEEE-754 double range),
  // so this is a real reachable input, not just a defense-in-depth guard.
  test("legacy flat NDJSON usage rejects an input_tokens that overflows to Infinity on JSON.parse", () => {
    const state = createParseState();
    // 1e400 is valid JSON number syntax but parses to Infinity (exceeds double range).
    expect(JSON.parse("1e400")).toBe(Number.POSITIVE_INFINITY);
    parseAcpxJsonLine('{"usage":{"input_tokens":1e400,"output_tokens":9}}', state);
    expect(finalizeParseState(state).tokenUsage).toBeUndefined();
  });

  test("legacy flat NDJSON usage still rejects a string input_tokens (unchanged behavior)", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"usage":{"input_tokens":"7","output_tokens":9}}', state);
    expect(finalizeParseState(state).tokenUsage).toBeUndefined();
  });
});

// BUG-12: the JSON-RPC session/update usage_update branch (distinct from the
// legacy flat NDJSON branch above) had four bare `typeof x === "number"`
// checks instead of asFiniteNumber — the one place in this file that skipped
// the convention. A malformed/overflowing usage_update must not poison
// inputTokens/outputTokens/costUsd/exactCostUsd with Infinity or NaN.
describe("BUG-12 — JSON-RPC usage_update rejects non-finite values", () => {
  function usageUpdateLine(update: Record<string, unknown>): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "x", update: { sessionUpdate: "usage_update", ...update } },
    });
  }

  test("rejects an _meta.usage.inputTokens that overflows to Infinity", () => {
    const state = createParseState();
    const line = usageUpdateLine({ _meta: { usage: { inputTokens: 1e400, outputTokens: 9 } } });
    const activity = parseAcpxJsonLine(line, state);
    expect(activity?.inputTokens).toBeUndefined();
    expect(activity?.outputTokens).toBe(9);
  });

  test("rejects an _meta.usage.outputTokens that overflows to Infinity", () => {
    const state = createParseState();
    const line = usageUpdateLine({ _meta: { usage: { inputTokens: 7, outputTokens: 1e400 } } });
    const activity = parseAcpxJsonLine(line, state);
    expect(activity?.inputTokens).toBe(7);
    expect(activity?.outputTokens).toBeUndefined();
  });

  test("rejects a fallback `used` field that overflows to Infinity", () => {
    const state = createParseState();
    const line = usageUpdateLine({ used: 1e400 });
    const activity = parseAcpxJsonLine(line, state);
    expect(activity?.outputTokens).toBeUndefined();
  });

  test("rejects a cost.amount that overflows to Infinity — exactCostUsd is never poisoned", () => {
    const state = createParseState();
    const line = usageUpdateLine({ cost: { amount: 1e400, currency: "USD" } });
    const activity = parseAcpxJsonLine(line, state);
    expect(activity?.costUsd).toBeUndefined();
    expect(state.exactCostUsd).toBeUndefined();
  });

  test("still accepts finite values across all four fields", () => {
    const state = createParseState();
    const line = usageUpdateLine({
      _meta: { usage: { inputTokens: 7, outputTokens: 9 } },
      cost: { amount: 0.05, currency: "USD" },
    });
    const activity = parseAcpxJsonLine(line, state);
    expect(activity?.inputTokens).toBe(7);
    expect(activity?.outputTokens).toBe(9);
    expect(activity?.costUsd).toBe(0.05);
    expect(state.exactCostUsd).toBe(0.05);
  });
});

describe("BUG-10 — cumulative_token_usage rejects malformed (non-numeric) token values", () => {
  test("a string input_tokens is not assigned to state.tokenUsage as-is", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"cumulative_token_usage":{"input_tokens":"123","output_tokens":50}}', state);
    const usage = finalizeParseState(state).tokenUsage;
    // Malformed record must not fabricate/pass through a string field — same
    // "don't fabricate" convention as BUG-54 above, applied to invalid (not
    // just missing) required fields.
    expect(usage).toBeUndefined();
  });

  test("a non-finite output_tokens (NaN via bad JSON-adjacent value) is rejected", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"cumulative_token_usage":{"input_tokens":10,"output_tokens":"not-a-number"}}', state);
    expect(finalizeParseState(state).tokenUsage).toBeUndefined();
  });

  test("a well-formed cumulative_token_usage still populates tokenUsage", () => {
    const state = createParseState();
    parseAcpxJsonLine(
      '{"cumulative_token_usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5}}',
      state,
    );
    const usage = finalizeParseState(state).tokenUsage;
    expect(usage?.input_tokens).toBe(10);
    expect(usage?.output_tokens).toBe(20);
    expect(usage?.cache_read_input_tokens).toBe(5);
  });

  test("cache fields default to 0 when absent from an otherwise-valid record", () => {
    const state = createParseState();
    parseAcpxJsonLine('{"cumulative_token_usage":{"input_tokens":10,"output_tokens":20}}', state);
    const usage = finalizeParseState(state).tokenUsage;
    expect(usage?.cache_read_input_tokens).toBe(0);
    expect(usage?.cache_creation_input_tokens).toBe(0);
  });
});
