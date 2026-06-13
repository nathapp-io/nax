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
