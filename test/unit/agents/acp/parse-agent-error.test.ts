import { describe, expect, test } from "bun:test";
import { parseAgentError } from "../../../../src/agents/acp/parse-agent-error";

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

  test("detects rate-limit from JSON statusCode", () => {
    const result = parseAgentError('{"statusCode":429}');
    expect(result.type).toBe("rate-limit");
  });

  test("detects auth from JSON statusCode", () => {
    const result = parseAgentError('{"statusCode":401}');
    expect(result.type).toBe("auth");
  });

  test("detects rate-limit from bracketed acpx codes", () => {
    const result = parseAgentError("acpx session failed [ACPX_RATE_LIMIT/TOO_MANY_REQUESTS]");
    expect(result.type).toBe("rate-limit");
  });

  test("detects auth from bracketed acpx codes", () => {
    const result = parseAgentError("acpx auth failed [AUTH_FAILED/PERMISSION_DENIED]");
    expect(result.type).toBe("auth");
  });

  test("detects structured key-value status codes", () => {
    const rateLimit = parseAgentError("statusCode=429");
    const auth = parseAgentError("code=403");
    expect(rateLimit.type).toBe("rate-limit");
    expect(auth.type).toBe("auth");
  });

  test("does not infer rate-limit from free-text phrases", () => {
    const result = parseAgentError("Rate limit hit, retry after 60");
    expect(result.type).toBe("unknown");
  });

  test("does not infer auth from free-text phrases", () => {
    const result = parseAgentError("Unauthorized request");
    expect(result.type).toBe("unknown");
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
      const stderr =
        'throttled {"type":"error","error":{"type":"rate_limit_error","retryAfterSeconds":42}}';
      const result = parseAgentError(stderr);
      expect(result.type).toBe("rate-limit");
      expect(result.retryAfterSeconds).toBe(42);
    });

    test("detects auth from permission_error variant", () => {
      const stderr = 'boom {"type":"error","error":{"type":"permission_error"}}';
      expect(parseAgentError(stderr).type).toBe("auth");
    });

    test("detects auth from invalid_api_key_error variant", () => {
      const stderr = 'boom {"type":"error","error":{"type":"invalid_api_key_error"}}';
      expect(parseAgentError(stderr).type).toBe("auth");
    });

    test("detects rate-limit from overloaded_error variant", () => {
      const stderr = 'boom {"type":"error","error":{"type":"overloaded_error"}}';
      expect(parseAgentError(stderr).type).toBe("rate-limit");
    });

    test("root JSON Anthropic envelope also classifies (not just embedded)", () => {
      const root = '{"type":"error","error":{"type":"authentication_error"}}';
      expect(parseAgentError(root).type).toBe("auth");
    });

    test("unrelated inner error type leaves classification unknown", () => {
      const stderr = 'boom {"type":"error","error":{"type":"invalid_request_error"}}';
      // Not one of the known auth/rate-limit variants.
      expect(parseAgentError(stderr).type).toBe("unknown");
    });

    test("nested JSON with braces inside a string literal is parsed correctly", () => {
      const stderr =
        'prefix {"type":"error","error":{"type":"authentication_error","message":"please set `{authHeader}` properly"}} suffix';
      expect(parseAgentError(stderr).type).toBe("auth");
    });

    test("does not misclassify when embedded JSON is unrelated", () => {
      const stderr = 'log: {"user":"alice","event":"login"}';
      expect(parseAgentError(stderr).type).toBe("unknown");
    });

    test("still returns unknown when no embedded JSON exists", () => {
      // Free-text-only — no structured signal anywhere. Must stay unknown
      // (no free-text phrase inference).
      expect(parseAgentError("Internal error: Failed to authenticate. API Error: 401").type).toBe("unknown");
    });
  });

  // acpx 0.6.1 strict --model validation (two signal paths)
  describe("model-not-available errors", () => {
    // Codex-style: acpx rejects the model at sessions ensure time and emits a
    // JSON-RPC error on stdout. After the spawn-client fix, the error message
    // embeds that JSON. Message prefix is stable — from acpx model-support.ts.
    test("detects model-not-available from embedded JSON-RPC error (Codex ensure path)", () => {
      const stdout =
        '[acp-adapter] Failed to create session: {"jsonrpc":"2.0","id":null,"error":{"code":-32603,' +
        '"message":"Cannot apply --model \\"bad-model-xyz\\": the ACP agent did not advertise that model.' +
        ' Available models: gpt-5.5/low, gpt-5.5/medium.","data":{"acpxCode":"RUNTIME","origin":"cli","sessionId":"unknown"}}}';
      const result = parseAgentError(stdout);
      expect(result.type).toBe("model-not-available");
    });

    test("detects model-not-available for the advertise-model-support variant (Codex no ACP models)", () => {
      const stdout =
        '[acp-adapter] Failed to create session: {"jsonrpc":"2.0","id":null,"error":{"code":-32603,' +
        '"message":"Cannot apply --model \\"sonnet\\": the ACP agent did not advertise model support.",' +
        '"data":{"acpxCode":"RUNTIME","origin":"cli","sessionId":"unknown"}}}';
      const result = parseAgentError(stdout);
      expect(result.type).toBe("model-not-available");
    });

    // Claude-style: Claude Code accepts the model at session/new but rejects it
    // when the prompt is sent. The error arrives as a flat string (no JSON).
    test("detects model-not-available from Claude Code flat error string", () => {
      const errorMsg =
        "Internal error: There's an issue with the selected model (bad-model-xyz)." +
        " It may not exist or you may not have access to it. Run --model to pick a different model.";
      const result = parseAgentError(errorMsg);
      expect(result.type).toBe("model-not-available");
    });

    test("detects model-not-available for the replay-saved-model variant", () => {
      const result = parseAgentError(
        'Cannot replay saved model "claude-sonnet-4-5": the ACP agent did not advertise that model.',
      );
      expect(result.type).toBe("model-not-available");
    });

    test("model-not-available has no retryAfterSeconds", () => {
      const result = parseAgentError(
        'Cannot apply --model "x": the ACP agent did not advertise that model. Available models: none advertised.',
      );
      expect(result.type).toBe("model-not-available");
      expect((result as { retryAfterSeconds?: number }).retryAfterSeconds).toBeUndefined();
    });

    test("does not classify generic RUNTIME acpxCode as model-not-available", () => {
      // RUNTIME is used for many errors — must not classify without the message prefix.
      const result = parseAgentError(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Some other runtime error",' +
          '"data":{"acpxCode":"RUNTIME","origin":"cli"}}}',
      );
      expect(result.type).toBe("unknown");
    });

    test("does not classify invalid_request_error Anthropic envelope as model-not-available", () => {
      const result = parseAgentError('boom {"type":"error","error":{"type":"invalid_request_error"}}');
      expect(result.type).toBe("unknown");
    });
  });
});
