import { describe, expect, test } from "bun:test";
import { parseAgentError } from "@/agents/acp/parse-agent-error";

describe("parseAgentError", () => {
  test("detects rate-limit from direct JSON type", () => {
    const result = parseAgentError('{"type":"rate-limit","retryAfterSeconds":60}');
    expect(result.type).toBe("rate-limit");
    expect(result.retryAfterSeconds).toBe(60);
  });

  test("detects auth from direct JSON type", () => {
    const result = parseAgentError('{"type":"auth"}');
    expect(result.type).toBe("auth");
  });

  test.each([
    ["rate-limit", '{"statusCode":429}'],
    ["auth", '{"statusCode":401}'],
  ] as const)("detects %s from JSON statusCode", (type, input) => {
    expect(parseAgentError(input).type).toBe(type);
  });

  test.each([
    ["rate-limit", "acpx session failed [ACPX_RATE_LIMIT/TOO_MANY_REQUESTS]"],
    ["auth", "acpx auth failed [AUTH_FAILED/PERMISSION_DENIED]"],
  ] as const)("detects %s from bracketed acpx codes", (type, input) => {
    expect(parseAgentError(input).type).toBe(type);
  });

  test("detects structured key-value status codes", () => {
    const rateLimit = parseAgentError("statusCode=429");
    const auth = parseAgentError("code=403");
    expect(rateLimit.type).toBe("rate-limit");
    expect(auth.type).toBe("auth");
  });

  test.each([
    ["rate-limit", "Rate limit hit, retry after 60"],
    ["auth", "Unauthorized request"],
  ] as const)("does not infer %s from free-text phrases", (_type, input) => {
    expect(parseAgentError(input).type).toBe("unknown");
  });

  test("returns unknown for empty or unstructured errors", () => {
    expect(parseAgentError("").type).toBe("unknown");
    expect(parseAgentError("something went wrong").type).toBe("unknown");
  });

  // #592: acpx wraps vendor errors in a human-readable prefix. The embedded
  // JSON envelope must still classify cleanly so AgentManager.shouldSwap fires.
  describe("#592 — embedded Anthropic error envelope", () => {
    test("detects auth from embedded Anthropic authentication_error envelope", () => {
      const stderr =
        'Internal error: Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"login fail: Please carry the API secret key in the \'Authorization\' field of the request header"},"request_id":"0634d680c8f2e70e15e50e20bebaf407"}';
      const result = parseAgentError(stderr);
      expect(result.type).toBe("auth");
    });

    test("detects rate-limit from embedded Anthropic rate_limit_error envelope", () => {
      const stderr =
        'Internal error: Too many requests. API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}';
      const result = parseAgentError(stderr);
      expect(result.type).toBe("rate-limit");
    });

    test("detects rate-limit with retryAfterSeconds from inner envelope", () => {
      const stderr = 'throttled {"type":"error","error":{"type":"rate_limit_error","retryAfterSeconds":42}}';
      const result = parseAgentError(stderr);
      expect(result.type).toBe("rate-limit");
      expect(result.retryAfterSeconds).toBe(42);
    });

    test.each([
      ["permission_error variant", 'boom {"type":"error","error":{"type":"permission_error"}}'],
      ["invalid_api_key_error variant", 'boom {"type":"error","error":{"type":"invalid_api_key_error"}}'],
    ])("detects auth from %s", (_label, stderr) => {
      expect(parseAgentError(stderr).type).toBe("auth");
    });

    test("detects rate-limit from overloaded_error variant", () => {
      const stderr = 'boom {"type":"error","error":{"type":"overloaded_error"}}';
      expect(parseAgentError(stderr).type).toBe("rate-limit");
    });

    test.each([
      ["root JSON Anthropic envelope", '{"type":"error","error":{"type":"authentication_error"}}'],
      [
        "nested JSON with braces inside a string literal",
        'prefix {"type":"error","error":{"type":"authentication_error","message":"please set `{authHeader}` properly"}} suffix',
      ],
    ])("detects auth from %s", (_label, input) => {
      expect(parseAgentError(input).type).toBe("auth");
    });

    test.each([
      ["unrelated inner error type", 'boom {"type":"error","error":{"type":"invalid_request_error"}}'],
      ["embedded JSON is unrelated", 'log: {"user":"alice","event":"login"}'],
      ["no embedded JSON exists", "Internal error: Failed to authenticate. API Error: 401"],
    ])("%s leaves classification unknown", (_label, input) => {
      expect(parseAgentError(input).type).toBe("unknown");
    });
  });

  // acpx 0.6.1 strict --model validation (two signal paths)
  describe("model-not-available errors", () => {
    // Codex-style: acpx rejects the model at sessions ensure time and emits a
    // JSON-RPC error on stdout. After the spawn-client fix, the error message
    // embeds that JSON. Message prefix is stable — from acpx model-support.ts.
    test.each([
      [
        "embedded JSON-RPC error (Codex ensure path)",
        '[acp-adapter] Failed to create session: {"jsonrpc":"2.0","id":null,"error":{"code":-32603,' +
          '"message":"Cannot apply --model \\"bad-model-xyz\\": the ACP agent did not advertise that model.' +
          ' Available models: gpt-5.5/low, gpt-5.5/medium.","data":{"acpxCode":"RUNTIME","origin":"cli","sessionId":"unknown"}}}',
      ],
      [
        "advertise-model-support variant (Codex no ACP models)",
        '[acp-adapter] Failed to create session: {"jsonrpc":"2.0","id":null,"error":{"code":-32603,' +
          '"message":"Cannot apply --model \\"sonnet\\": the ACP agent did not advertise model support.",' +
          '"data":{"acpxCode":"RUNTIME","origin":"cli","sessionId":"unknown"}}}',
      ],
      // Claude-style: Claude Code accepts the model at session/new but rejects it
      // when the prompt is sent. The error arrives as a flat string (no JSON).
      [
        "Claude Code flat error string",
        "Internal error: There's an issue with the selected model (bad-model-xyz)." +
          " It may not exist or you may not have access to it. Run --model to pick a different model.",
      ],
      [
        "replay-saved-model variant",
        'Cannot replay saved model "claude-sonnet-4-5": the ACP agent did not advertise that model.',
      ],
    ])("detects model-not-available from %s", (_label, input) => {
      expect(parseAgentError(input).type).toBe("model-not-available");
    });

    test("model-not-available has no retryAfterSeconds", () => {
      const result = parseAgentError(
        'Cannot apply --model "x": the ACP agent did not advertise that model. Available models: none advertised.',
      );
      expect(result.type).toBe("model-not-available");
      expect((result as { retryAfterSeconds?: number }).retryAfterSeconds).toBeUndefined();
    });

    test.each([
      [
        "generic RUNTIME acpxCode",
        // RUNTIME is used for many errors — must not classify without the message prefix.
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Some other runtime error","data":{"acpxCode":"RUNTIME","origin":"cli"}}}',
      ],
      ["invalid_request_error Anthropic envelope", 'boom {"type":"error","error":{"type":"invalid_request_error"}}'],
    ])("does not classify %s as model-not-available", (_label, input) => {
      expect(parseAgentError(input).type).toBe("unknown");
    });
  });

  // ENH-1: JSON-RPC error envelopes carry the classification code in
  // error.data.acpxCode, not at the top level. A pure-JSON envelope (whole
  // string parses as JSON) never reaches the embedded-JSON scan, and the
  // key-value regex defeats JSON-quoted codes — so the nested object must be
  // walked explicitly.
  describe("ENH-1 — nested error.data codes", () => {
    test("detects rate-limit from error.data.acpxCode in a pure-JSON envelope", () => {
      const stderr =
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"rate limited","data":{"acpxCode":"RATE_LIMIT","origin":"cli"}}}';
      const result = parseAgentError(stderr);
      expect(result.type).toBe("rate-limit");
    });

    test("detects auth from error.data.acpxCode in a pure-JSON envelope", () => {
      const stderr =
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"auth failed","data":{"acpxCode":"AUTH_FAILED"}}}';
      const result = parseAgentError(stderr);
      expect(result.type).toBe("auth");
    });

    test("walks nested error.data when the envelope is embedded in free text", () => {
      const stderr =
        'probe failed: {"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"quota","data":{"acpxCode":"QUOTA_EXCEEDED","retryAfterSeconds":30}}}';
      const result = parseAgentError(stderr);
      expect(result.type).toBe("rate-limit");
      expect(result.retryAfterSeconds).toBe(30);
    });

    test("leaves unknown when error.data has no classifiable code", () => {
      const stderr =
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"some error","data":{"acpxCode":"RUNTIME"}}}';
      expect(parseAgentError(stderr).type).toBe("unknown");
    });
  });
});
