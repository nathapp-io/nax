import { describe, expect, test } from "bun:test";
import { parseAcpxJsonOutput } from "../../../../src/agents/acp/parser";

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

describe("parseAcpxJsonOutput — acpx result.record.cumulative_token_usage format", () => {
  test("extracts token usage from result.record.cumulative_token_usage (acpx prompt format)", () => {
    const output = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        stopReason: "end_turn",
        sessionId: "nax-test-session",
        resumed: true,
        permissionStats: { requested: 0, approved: 0, denied: 0, cancelled: 0 },
        record: {
          acpxRecordId: "r1",
          acpSessionId: "s1",
          agentCommand: "claude",
          cwd: "/repo",
          createdAt: "2026-03-18T10:00:00Z",
          lastUsedAt: "2026-03-18T10:01:00Z",
          messages: [],
          updated_at: "2026-03-18T10:01:00Z",
          lastSeq: 1,
          eventLog: {},
          cumulative_token_usage: {
            input_tokens: 5432,
            output_tokens: 987,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        },
      },
    });

    const result = parseAcpxJsonOutput(output);
    expect(result.tokenUsage?.input_tokens).toBe(5432);
    expect(result.tokenUsage?.output_tokens).toBe(987);
    expect(result.tokenUsage?.cache_read_input_tokens).toBe(100);
    expect(result.tokenUsage?.cache_creation_input_tokens).toBe(50);
    expect(result.stopReason).toBe("end_turn");
    // acpx does not emit cost.amount — exactCostUsd should be undefined (estimated downstream)
    expect(result.exactCostUsd).toBeUndefined();
  });

  test("result.usage takes precedence over result.record.cumulative_token_usage when both present", () => {
    const output = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50 },
        record: {
          cumulative_token_usage: { input_tokens: 9999, output_tokens: 9999 },
        },
      },
    });

    const result = parseAcpxJsonOutput(output);
    // result.usage wins
    expect(result.tokenUsage?.input_tokens).toBe(100);
    expect(result.tokenUsage?.output_tokens).toBe(50);
  });

  test("falls back to result.record.cumulative_token_usage when result.usage absent", () => {
    const output = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        stopReason: "end_turn",
        record: {
          cumulative_token_usage: { input_tokens: 200, output_tokens: 75 },
        },
      },
    });

    const result = parseAcpxJsonOutput(output);
    expect(result.tokenUsage?.input_tokens).toBe(200);
    expect(result.tokenUsage?.output_tokens).toBe(75);
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
});
